import { accounts, type Db, transactions } from "@yomi/db";
import { type NormalizedRow, type Notice, notice, type SourceId } from "@yomi/importers";
import { and, eq, gte, inArray, isNull, lt, type SQL } from "@yomi/db/orm";
import { splitAndSettledIds } from "../ledger/lock";
import { getTimeZone } from "../settings/time-zone";
import { addDays, dayNumber } from "../time/day";
import { occurredOnFor } from "../time/zone";
import type { CurrentUser } from "../user";
import { type AccountSpec, parsePaymentMethod } from "./accounts";

// Fuzzy links between a new file's rows and rows already in the ledger: the same charge seen by the card and by the
// wallet that paid with it, or by BoA CSV and Plaid. Each pass loads its candidates with one query (amount, currency,
// ±LINK_WINDOW_DAYS around the file's dates) plus one lookup of rows already pointing at them, then matches in memory
// in file order: per row, the nearest day wins, then the lower id.

/** The part of a planned row the link passes read and set. */
export interface LinkRow {
  row: NormalizedRow;
  spec: AccountSpec;
  isDup: boolean;
  duplicateOfId: number | null;
  /** Wallet row only: an existing bank row that duplicates it; linked to this row after insert. */
  linkBankId: number | null;
}

/** Sources whose rows are the card's own record; they link to the Alipay/WeChat row paid with that card. */
const BANK_SOURCES = ["icbc_pdf", "plaid", "boa_csv"] as const;
const isBankSource = (s: string) => (BANK_SOURCES as readonly string[]).includes(s);
const isWalletSource = (s: string) => s === "alipay" || s === "wechat";

/** BoA CSV and Plaid both see Bank of America accounts; rows of one link to the other's. */
const BOA_INSTITUTION = /bank\s*of\s*america|\bbofa\b|\bboa\b/i;
const CROSS_SOURCE: Partial<Record<SourceId, SourceId>> = { boa_csv: "plaid", plaid: "boa_csv" };

const LINK_WINDOW_DAYS = 3;
const LOOKUP_CHUNK = 1000;

type Charge = { currency: string; amountMinor: number };
const chargeKey = (c: Charge) => `${c.currency}|${c.amountMinor}`;

/**
 * The SQL side of a pass: same currency and amount as one of `rows`, ok, not a duplicate, and dated within the window
 * of the earliest to the latest row. The window counts the stated date (the first 10 characters of occurred_at, as
 * dayNumber does), so it bounds occurred_at, not the zone-dependent occurred_on.
 */
function candidateFilter(userId: number, rows: readonly LinkRow[]): SQL {
  const days = rows.map((p) => p.row.occurredAt.slice(0, 10)).sort();
  return and(
    eq(transactions.userId, userId),
    inArray(transactions.currency, [...new Set(rows.map((p) => p.row.currency))]),
    inArray(transactions.amountMinor, [...new Set(rows.map((p) => p.row.amountMinor))]),
    eq(transactions.status, "ok"),
    isNull(transactions.duplicateOfId),
    gte(transactions.occurredAt, addDays(days[0]!, -LINK_WINDOW_DAYS)),
    lt(transactions.occurredAt, addDays(days.at(-1)!, LINK_WINDOW_DAYS + 1)),
  )!;
}

function byCharge<T extends Charge>(xs: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = chargeKey(x);
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

/** Candidates within the window of `row`, nearest day first, then the lower id. */
function nearest<T extends { id: number; occurredAt: string }>(candidates: readonly T[], row: NormalizedRow): T[] {
  const day = dayNumber(row.occurredAt);
  const gap = (c: T) => Math.abs(dayNumber(c.occurredAt) - day);
  return candidates.filter((c) => gap(c) <= LINK_WINDOW_DAYS).sort((a, b) => gap(a) - gap(b) || a.id - b.id);
}

/** For each of `ids`, the sources of the user's rows that already point at it (duplicate_of_id). */
async function linkedSources(q: Db, userId: number, ids: readonly number[]): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const rows = await q
      .select({ id: transactions.duplicateOfId, source: transactions.source })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), inArray(transactions.duplicateOfId, ids.slice(i, i + LOOKUP_CHUNK))));
    for (const r of rows) {
      if (r.id == null) continue;
      const set = out.get(r.id) ?? new Set<string>();
      set.add(r.source);
      out.set(r.id, set);
    }
  }
  return out;
}

/** New bank rows → the Alipay/WeChat row paid with the same card that no other row points at yet. */
async function linkBankRows(q: Db, userId: number, planned: readonly LinkRow[]): Promise<void> {
  const rows = planned.filter((p) => !p.isDup && p.duplicateOfId == null && isBankSource(p.row.source) && p.row.status === "ok" && p.spec.last4);
  if (rows.length === 0) return;
  const pool = await q
    .select({ id: transactions.id, occurredAt: transactions.occurredAt, paymentMethod: transactions.paymentMethod, currency: transactions.currency, amountMinor: transactions.amountMinor })
    .from(transactions)
    .where(and(candidateFilter(userId, rows), inArray(transactions.source, ["alipay", "wechat"])));
  const linked = await linkedSources(q, userId, pool.map((c) => c.id));
  const charges = byCharge(pool);
  const claimed = new Set<number>();
  for (const p of rows) {
    const candidates = (charges.get(chargeKey(p.row)) ?? []).filter((c) => !claimed.has(c.id) && parsePaymentMethod(c.paymentMethod)?.last4 === p.spec.last4);
    const best = nearest(candidates, p.row).find((c) => !linked.has(c.id));
    if (best) {
      p.duplicateOfId = best.id;
      claimed.add(best.id);
    }
  }
}

/**
 * New Alipay/WeChat rows paid by card → a bank row imported earlier. The wallet row becomes the canonical one and the
 * bank row points at it, unless the user already worked on the bank row (split, settlement, edit); then both stay and
 * a warning says so. A card alert the user kept (split, settled, edited) is the record instead: the wallet row points
 * at it, so the charge counts once.
 */
async function linkWalletRows(q: Db, user: CurrentUser, planned: readonly LinkRow[], warnings: Notice[]): Promise<void> {
  const rows = planned.filter((p) => !p.isDup && isWalletSource(p.row.source) && p.row.status === "ok" && p.spec.last4);
  if (rows.length === 0) return;
  const pool = await q
    .select({
      id: transactions.id,
      source: transactions.source,
      occurredAt: transactions.occurredAt,
      paymentMethod: transactions.paymentMethod,
      accountLast4: accounts.last4,
      userEditedAt: transactions.userEditedAt,
      currency: transactions.currency,
      amountMinor: transactions.amountMinor,
    })
    .from(transactions)
    .leftJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        candidateFilter(user.id, rows),
        // A card alert no statement confirmed yet is matched as a capture after insert (runMatching); one that
        // is final (kept, or confirmed with the user's split) is the card's own record here.
        inArray(transactions.source, [...BANK_SOURCES, "sms"]),
        isNull(transactions.provisional),
      ),
    );
  const charges = byCharge(pool);
  const claimed = new Set<number>();
  const picks: { p: LinkRow; best: (typeof pool)[number] }[] = [];
  for (const p of rows) {
    const candidates = (charges.get(chargeKey(p.row)) ?? []).filter(
      (c) => !claimed.has(c.id) && (parsePaymentMethod(c.paymentMethod)?.last4 ?? c.accountLast4) === p.spec.last4,
    );
    const best = nearest(candidates, p.row)[0];
    if (!best) continue;
    claimed.add(best.id);
    picks.push({ p, best });
  }
  if (picks.length === 0) return;
  const locks = await splitAndSettledIds(q, user.id, picks.map(({ best }) => best.id));
  const zone = await getTimeZone(q, user);
  for (const { p, best } of picks) {
    const split = locks.split.has(best.id);
    const settled = locks.settled.has(best.id);
    if ((split || settled || best.userEditedAt != null) && best.source === "sms") {
      p.duplicateOfId = best.id;
      continue;
    }
    if (split || settled || best.userEditedAt != null) {
      const reason = split ? "split" : settled ? "settled" : "edited";
      const words = { split: "split", settled: "recorded as a settlement", edited: "edited by hand" }[reason];
      const date = occurredOnFor(p.row.occurredAt, p.row.source, zone);
      warnings.push(
        notice(
          "import_link_locked",
          `Row ${p.row.lineNo} (${date} ${p.row.amountMinor}) may be the same as bank transaction #${best.id}, but that one is ${words}, so they were not linked; please check`,
          { line: p.row.lineNo, date, amountMinor: p.row.amountMinor, id: best.id, reason },
        ),
      );
      continue;
    }
    p.linkBankId = best.id;
  }
}

/**
 * BoA CSV ↔ Plaid: the same Bank of America transaction arrives through both. The later row points at the earlier one
 * (same institution, same account kind, amount, currency, ±3 days) that no row of its own source points at yet; the
 * earlier row is never touched, so its splits, settlements and edits stay where they are. Accounts are not merged: the
 * CSV has no account number, so its ledger account stays separate from Plaid's.
 */
async function linkBoaRows(q: Db, userId: number, planned: readonly LinkRow[]): Promise<void> {
  const rows = planned.filter(
    (p) => CROSS_SOURCE[p.row.source] && !p.isDup && p.duplicateOfId == null && p.row.status === "ok" && BOA_INSTITUTION.test(p.spec.institution ?? ""),
  );
  if (rows.length === 0) return;
  const pool = await q
    .select({
      id: transactions.id,
      source: transactions.source,
      occurredAt: transactions.occurredAt,
      institution: accounts.institution,
      kind: accounts.kind,
      currency: transactions.currency,
      amountMinor: transactions.amountMinor,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        candidateFilter(userId, rows),
        inArray(transactions.source, [...new Set(rows.map((p) => CROSS_SOURCE[p.row.source]!))]),
        inArray(accounts.kind, [...new Set(rows.map((p) => p.spec.kind))]),
      ),
    );
  const linked = await linkedSources(q, userId, pool.map((c) => c.id));
  const charges = byCharge(pool);
  const claimed = new Set<number>();
  for (const p of rows) {
    const other = CROSS_SOURCE[p.row.source];
    const candidates = (charges.get(chargeKey(p.row)) ?? []).filter(
      (c) => c.source === other && c.kind === p.spec.kind && !claimed.has(c.id) && BOA_INSTITUTION.test(c.institution ?? ""),
    );
    const best = nearest(candidates, p.row).find((c) => !linked.get(c.id)?.has(p.row.source));
    if (best) {
      p.duplicateOfId = best.id;
      claimed.add(best.id);
    }
  }
}

/** Runs the link passes over a file's planned rows in order (bank, wallet, BoA ↔ Plaid); sets their links, adds warnings. */
export async function planLinks(q: Db, user: CurrentUser, planned: readonly LinkRow[], warnings: Notice[]): Promise<void> {
  await linkBankRows(q, user.id, planned);
  await linkWalletRows(q, user, planned, warnings);
  await linkBoaRows(q, user.id, planned);
}
