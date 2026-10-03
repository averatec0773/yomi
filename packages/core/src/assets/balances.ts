// Account balance snapshots: writers (Plaid balances, ICBC statement balance, starting balance, daily
// carry-forward) and the reader that turns them into daily balances per account and currency.
import { accountBalanceSnapshots, accounts, bankAccounts, type BalanceSource, type Db, importBatches, jobs, transactions } from "@yomi/db";
import { CodedError, decimalToMinor, type ErrorKind, type MessageParams, type NormalizedRow } from "@yomi/importers";
import { and, asc, eq, gt, isNull, lte, sum } from "@yomi/db/orm";
import { minorDigits } from "../money";
import { getTimeZone } from "../settings/time-zone";
import { addDays, isDate } from "../time/day";
import type { ProviderAccount } from "../sync/provider";
import { clockNow, todayIn } from "../time/zone";
import type { CurrentUser } from "../user";

export type AssetsErrorCode = "assets_account_not_found" | "assets_invalid_date" | "assets_invalid_amount";

export class AssetsError extends CodedError {
  constructor(kind: ErrorKind, code: AssetsErrorCode, message: string, params: MessageParams = {}) {
    super(kind, code, message, params);
    this.name = "AssetsError";
  }
}

export const BALANCE_SNAPSHOT_JOB = "balance-snapshots";

/** Cash (bank accounts, wallets, cash) or a card (credit card: its balance is what is owed, negative). */
export type BalanceClass = "cash" | "card";
export const balanceClassOf = (kind: string): BalanceClass => (kind === "credit_card" ? "card" : "cash");

export interface SnapshotRaw {
  /** A daily carry-forward copy: the day of the balance it repeats. */
  carriedFrom?: string;
  /** The starting balance the user set. */
  startingBalance?: boolean;
  /** Import batch a statement balance came from (removed when the batch is reverted). */
  batchId?: number;
  [k: string]: unknown;
}

/** The snapshot's jsonb `raw`, or {} when it is null or not an object. */
export function parseSnapshotRaw(raw: unknown): SnapshotRaw {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as SnapshotRaw) : {};
}

export interface BalanceSnapshotInput {
  accountId: number;
  asOf: string;
  balanceMinor: number;
  currency: string;
  source: BalanceSource;
  raw?: SnapshotRaw | null;
}

/**
 * Writes one snapshot (a later write for the same account, day and currency replaces it). A real
 * balance (not a carry-forward copy) also drops the carry-forward copies after its day that repeated a
 * balance older than it.
 */
export async function upsertBalanceSnapshot(q: Db, user: CurrentUser, s: BalanceSnapshotInput): Promise<void> {
  const raw = s.raw && Object.keys(s.raw).length ? { ...s.raw } : null;
  await q.insert(accountBalanceSnapshots)
    .values({ userId: user.id, accountId: s.accountId, asOf: s.asOf, balanceMinor: s.balanceMinor, currency: s.currency, source: s.source, raw })
    .onConflictDoUpdate({
      target: [accountBalanceSnapshots.accountId, accountBalanceSnapshots.asOf, accountBalanceSnapshots.currency],
      set: { balanceMinor: s.balanceMinor, source: s.source, raw, updatedAt: new Date().toISOString() },
    });
  if (s.raw?.carriedFrom) return;
  const later = await q
    .select({ id: accountBalanceSnapshots.id, raw: accountBalanceSnapshots.raw })
    .from(accountBalanceSnapshots)
    .where(and(eq(accountBalanceSnapshots.accountId, s.accountId), eq(accountBalanceSnapshots.currency, s.currency), gt(accountBalanceSnapshots.asOf, s.asOf)));
  for (const r of later) {
    const from = parseSnapshotRaw(r.raw).carriedFrom;
    if (from && from < s.asOf) await q.delete(accountBalanceSnapshots).where(eq(accountBalanceSnapshots.id, r.id));
  }
}

// ---------- Plaid ----------

/**
 * Signed balance of a provider account in minor units: depository cash is `current` (else `available`);
 * credit and loan balances are what is owed, so they become negative. Investment accounts inside a bank
 * login are left out (holdings come from brokerage connections). Null when no balance was sent.
 */
export function providerBalanceMinor(a: ProviderAccount): { balanceMinor: number; currency: string } | null {
  if (a.type === "investment" || !a.balances) return null;
  const owed = a.type === "credit" || a.type === "loan";
  const value = a.balances.current ?? (owed ? null : a.balances.available);
  if (value == null) return null;
  const minor = decimalToMinor(value, minorDigits(a.currency));
  return { balanceMinor: owed ? -minor : minor, currency: a.currency };
}

/** Snapshots today's balances of a bank connection's accounts (called during each sync). Returns how many were written. */
export async function recordProviderBalances(q: Db, user: CurrentUser, connectionId: number, providerAccounts: readonly ProviderAccount[], today: string): Promise<number> {
  const ledgerOf = new Map(
    (await q
      .select({ providerAccountId: bankAccounts.providerAccountId, accountId: bankAccounts.accountId })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.userId, user.id), eq(bankAccounts.connectionId, connectionId)))
      )
      .map((r) => [r.providerAccountId, r.accountId]),
  );
  let n = 0;
  for (const a of providerAccounts) {
    const accountId = ledgerOf.get(a.providerAccountId);
    const b = providerBalanceMinor(a);
    if (accountId == null || !b) continue;
    await upsertBalanceSnapshot(q, user, {
      accountId,
      asOf: today,
      balanceMinor: b.balanceMinor,
      currency: b.currency,
      source: "plaid",
      raw: { type: a.type, subtype: a.subtype, ...a.balances },
    });
    n += 1;
  }
  return n;
}

// ---------- ICBC statement ----------

export interface StatementBalance {
  key: string;
  currency: string;
  asOf: string;
  balanceMinor: number;
  lineNo: number;
}

const rowDate = (r: NormalizedRow) => r.occurredAt.slice(0, 10);

/**
 * The closing balance per account (`key`) and currency of an ICBC statement: 账户余额 (account balance)
 * of the last row in that currency (latest time, then the later line). Dated the statement's end
 * (`periodEnd`) when it is not before that row, else the row's own day. Rows without a readable balance
 * are skipped. Negative means owed to the bank.
 */
export function statementBalances(items: readonly { key: string; row: NormalizedRow }[], periodEnd?: string): StatementBalance[] {
  const last = new Map<string, { key: string; row: NormalizedRow; minor: number }>();
  for (const it of items) {
    const text = it.row.raw?.["账户余额"];
    if (typeof text !== "string" || !text.trim()) continue;
    let minor: number;
    try {
      minor = decimalToMinor(text.replace(/,/g, "").trim(), minorDigits(it.row.currency));
    } catch {
      continue;
    }
    const k = `${it.key}\u0000${it.row.currency}`;
    const prev = last.get(k);
    if (!prev || it.row.occurredAt > prev.row.occurredAt || (it.row.occurredAt === prev.row.occurredAt && it.row.lineNo > prev.row.lineNo)) {
      last.set(k, { key: it.key, row: it.row, minor });
    }
  }
  return [...last.values()].map(({ key, row, minor }) => {
    const day = rowDate(row);
    return { key, currency: row.currency, asOf: periodEnd && isDate(periodEnd) && periodEnd >= day ? periodEnd : day, balanceMinor: minor, lineNo: row.lineNo };
  });
}

/**
 * Statement balances for ICBC imports made before balances were kept: each committed icbc_pdf batch
 * without a statement snapshot gets one from its stored rows' raw 账户余额 (dated the last row's day).
 * Idempotent. Returns the number of snapshots written.
 */
export async function backfillStatementBalances(q: Db, user: CurrentUser): Promise<number> {
  const done = new Set(
    (await q
      .select({ raw: accountBalanceSnapshots.raw })
      .from(accountBalanceSnapshots)
      .where(and(eq(accountBalanceSnapshots.userId, user.id), eq(accountBalanceSnapshots.source, "statement")))
      )
      .map((r) => parseSnapshotRaw(r.raw).batchId),
  );
  let n = 0;
  for (const b of (await q
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.userId, user.id), eq(importBatches.source, "icbc_pdf"), eq(importBatches.status, "committed")))
    .orderBy(asc(importBatches.id))
    )) {
    if (done.has(b.id)) continue;
    const rows = await q
      .select({ accountId: transactions.accountId, occurredAt: transactions.occurredAt, currency: transactions.currency, raw: transactions.raw })
      .from(transactions)
      .where(and(eq(transactions.userId, user.id), eq(transactions.importBatchId, b.id)))
      .orderBy(asc(transactions.occurredAt), asc(transactions.id));
    const items = rows.flatMap((r, i) => {
      if (r.accountId == null || !r.raw || typeof r.raw !== "object") return [];
      const raw = r.raw as Record<string, string>;
      return [{ key: String(r.accountId), row: { occurredAt: r.occurredAt, currency: r.currency, lineNo: i + 1, raw } as NormalizedRow }];
    });
    for (const s of statementBalances(items)) {
      await upsertBalanceSnapshot(q, user, {
        accountId: Number(s.key),
        asOf: s.asOf,
        balanceMinor: s.balanceMinor,
        currency: s.currency,
        source: "statement",
        raw: { batchId: b.id, backfilled: true },
      });
      n += 1;
    }
  }
  return n;
}

/** Removes the statement balances an import batch wrote (on revert). */
export async function removeBatchBalances(q: Db, user: CurrentUser, batchId: number): Promise<number> {
  const rows = await q
    .select({ id: accountBalanceSnapshots.id, raw: accountBalanceSnapshots.raw })
    .from(accountBalanceSnapshots)
    .where(and(eq(accountBalanceSnapshots.userId, user.id), eq(accountBalanceSnapshots.source, "statement")));
  let n = 0;
  for (const r of rows) {
    if (parseSnapshotRaw(r.raw).batchId !== batchId) continue;
    await q.delete(accountBalanceSnapshots).where(eq(accountBalanceSnapshots.id, r.id));
    n += 1;
  }
  return n;
}

// ---------- starting balance (derived accounts) ----------

export interface StartingBalanceInput {
  amountMinor: number;
  /** Day the balance is true at the end of. */
  on: string;
}

type AccountRow = typeof accounts.$inferSelect;

async function getAccount(q: Db, user: CurrentUser, id: number): Promise<AccountRow> {
  const a = (await q
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.id, id)))
    .limit(1))[0];
  if (!a) throw new AssetsError("not_found", "assets_account_not_found", `Account #${id} not found`, { id });
  return a;
}

/**
 * Sets (or with null clears) an account's starting balance: its balance at the end of `on`, in the
 * account's currency. From then on the account's balance is the starting balance plus its
 * transactions after that day. Also stored as a manual snapshot on that day; the previous starting
 * snapshot and the derived snapshots are replaced.
 */
export async function setStartingBalance(db: Db, user: CurrentUser, accountId: number, input: StartingBalanceInput | null): Promise<AccountRow> {
  if (input) {
    if (!isDate(input.on)) throw new AssetsError("invalid", "assets_invalid_date", `Invalid date: ${input.on}`, { date: input.on });
    if (!Number.isSafeInteger(input.amountMinor)) throw new AssetsError("invalid", "assets_invalid_amount", "Invalid amount");
  }
  return await db.transaction(async (tx) => {
    const a = await getAccount(tx, user, accountId);
    for (const r of (await tx
      .select({ id: accountBalanceSnapshots.id, source: accountBalanceSnapshots.source, raw: accountBalanceSnapshots.raw })
      .from(accountBalanceSnapshots)
      .where(eq(accountBalanceSnapshots.accountId, a.id))
      )) {
      const raw = parseSnapshotRaw(r.raw);
      if ((r.source === "manual" && raw.startingBalance) || (r.source === "derived" && !raw.carriedFrom)) {
        await tx.delete(accountBalanceSnapshots).where(eq(accountBalanceSnapshots.id, r.id));
      }
    }
    await tx.update(accounts)
      .set({ startingBalanceMinor: input?.amountMinor ?? null, startingBalanceOn: input?.on ?? null })
      .where(eq(accounts.id, a.id));
    if (input) {
      await upsertBalanceSnapshot(tx, user, {
        accountId: a.id,
        asOf: input.on,
        balanceMinor: input.amountMinor,
        currency: a.currency,
        source: "manual",
        raw: { startingBalance: true },
      });
    }
    return await getAccount(tx, user, a.id);
  });
}

/**
 * Net of an account's transactions per day and currency after `after` up to `to` (duplicates of rows
 * on another account and closed rows excluded), oldest first.
 */
async function netByDay(q: Db, user: CurrentUser, accountId: number, after: string, to: string): Promise<{ day: string; currency: string; minor: number }[]> {
  return (await q
    .select({ day: transactions.occurredOn, currency: transactions.currency, minor: sum(transactions.amountMinor) })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, user.id),
        eq(transactions.accountId, accountId),
        gt(transactions.occurredOn, after),
        lte(transactions.occurredOn, to),
        isNull(transactions.duplicateOfId),
        eq(transactions.status, "ok"),
      ),
    )
    .groupBy(transactions.occurredOn, transactions.currency)
    .orderBy(asc(transactions.occurredOn))
    )
    .map((r) => ({ day: r.day, currency: r.currency, minor: Number(r.minor ?? 0) }));
}

// ---------- reading: daily balances ----------

export interface BalanceSourceInfo {
  source: BalanceSource;
  /** Day of the balance itself (a carried copy reports the day it repeats). */
  asOf: string;
}

export interface AccountBalances {
  account: AccountRow;
  class: BalanceClass;
  /** The account is fed by a bank connection (Plaid). */
  plaidLinked: boolean;
  /** Per currency: balance per day of `days` (null before anything is known). */
  daily: Map<string, (number | null)[]>;
  /** Per currency: where the balance on the last day comes from. */
  sourceAt: Map<string, BalanceSourceInfo>;
}

export interface BalanceTimeline {
  days: string[];
  accounts: AccountBalances[];
}

/** Days from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Daily balances of every account from `from` to `to`. An account with a starting balance is derived on
 * and after that day (starting balance + its transactions since, per currency); otherwise, and before
 * it, the latest snapshot on or before each day carries forward. Accounts with nothing known are
 * included with empty maps.
 */
export async function balanceTimeline(db: Db, user: CurrentUser, range: { from: string; to: string }): Promise<BalanceTimeline> {
  const days = daysBetween(range.from, range.to);
  const linked = new Set(
    (await db
      .select({ id: bankAccounts.accountId })
      .from(bankAccounts)
      .where(eq(bankAccounts.userId, user.id))
      )
      .map((r) => r.id),
  );
  const snaps = await db
    .select()
    .from(accountBalanceSnapshots)
    .where(and(eq(accountBalanceSnapshots.userId, user.id), lte(accountBalanceSnapshots.asOf, range.to)))
    .orderBy(asc(accountBalanceSnapshots.asOf), asc(accountBalanceSnapshots.id));
  const out: AccountBalances[] = [];
  for (const a of (await db.select().from(accounts).where(eq(accounts.userId, user.id)).orderBy(asc(accounts.id)))) {
    const daily = new Map<string, (number | null)[]>();
    const sourceAt = new Map<string, BalanceSourceInfo>();
    const series = (c: string) => {
      let s = daily.get(c);
      if (!s) daily.set(c, (s = days.map(() => null)));
      return s;
    };
    const derivedFrom = a.startingBalanceOn != null && a.startingBalanceMinor != null && a.startingBalanceOn <= range.to ? a.startingBalanceOn : null;
    // Snapshots, carried forward (only before the derived start when there is one).
    const own = snaps.filter((s) => s.accountId === a.id && (derivedFrom == null || s.asOf < derivedFrom));
    const byCurrency = new Map<string, typeof own>();
    for (const s of own) byCurrency.set(s.currency, [...(byCurrency.get(s.currency) ?? []), s]);
    for (const [c, list] of byCurrency) {
      const s = series(c);
      let k = 0;
      let cur: (typeof own)[number] | null = null;
      for (let i = 0; i < days.length; i++) {
        const day = days[i]!;
        if (derivedFrom != null && day >= derivedFrom) break;
        while (k < list.length && list[k]!.asOf <= day) cur = list[k++]!;
        if (cur) s[i] = cur.balanceMinor;
      }
      if (cur && (derivedFrom == null || range.to < derivedFrom)) {
        const raw = parseSnapshotRaw(cur.raw);
        sourceAt.set(c, { source: cur.source, asOf: raw.carriedFrom ?? cur.asOf });
      }
    }
    if (derivedFrom != null) {
      const running = new Map<string, number>([[a.currency, a.startingBalanceMinor!]]);
      const nets = await netByDay(db, user, a.id, derivedFrom, range.to);
      let k = 0;
      for (let i = 0; i < days.length; i++) {
        const day = days[i]!;
        if (day < derivedFrom) continue;
        while (k < nets.length && nets[k]!.day <= day) {
          const n = nets[k++]!;
          running.set(n.currency, (running.get(n.currency) ?? 0) + n.minor);
        }
        for (const [c, v] of running) series(c)[i] = v;
      }
      for (const c of running.keys()) sourceAt.set(c, { source: "derived", asOf: derivedFrom });
    }
    out.push({ account: a, class: balanceClassOf(a.kind), plaidLinked: linked.has(a.id), daily, sourceAt });
  }
  return { days, accounts: out };
}

/**
 * The daily step: fills statement balances of older ICBC imports, then writes today's balance for
 * every account with a known balance, so history accumulates. Derived accounts get their computed balance (source derived); others get a copy of their
 * latest balance marked as carried (a real balance written later that day replaces it). Idempotent;
 * the jobs row `balance-snapshots` records the last day written. Returns the number of rows written,
 * or null when today was already done.
 */
export async function writeDailyBalanceSnapshots(db: Db, user: CurrentUser, opts: { now?: () => Date; force?: boolean } = {}): Promise<number | null> {
  const today = todayIn(await getTimeZone(db, user), (opts.now ?? (() => clockNow()))());
  const job = (await db
    .select({ cursor: jobs.cursor })
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), eq(jobs.name, BALANCE_SNAPSHOT_JOB)))
    .limit(1))[0];
  if (!opts.force && job?.cursor === today) return null;
  return await db.transaction(async (tx) => {
    let n = await backfillStatementBalances(tx, user);
    const existing = new Set(
      (await tx
        .select({ accountId: accountBalanceSnapshots.accountId, currency: accountBalanceSnapshots.currency })
        .from(accountBalanceSnapshots)
        .where(and(eq(accountBalanceSnapshots.userId, user.id), eq(accountBalanceSnapshots.asOf, today)))
        )
        .map((r) => `${r.accountId}|${r.currency}`),
    );
    const latest = new Map<string, typeof accountBalanceSnapshots.$inferSelect>();
    for (const s of (await tx
      .select()
      .from(accountBalanceSnapshots)
      .where(and(eq(accountBalanceSnapshots.userId, user.id), lte(accountBalanceSnapshots.asOf, today)))
      .orderBy(asc(accountBalanceSnapshots.asOf))
      )) {
      latest.set(`${s.accountId}|${s.currency}`, s);
    }
    for (const a of (await balanceTimeline(tx, user, { from: today, to: today })).accounts) {
      for (const [c, s] of a.daily) {
        const v = s[0];
        if (v == null) continue;
        const key = `${a.account.id}|${c}`;
        const info = a.sourceAt.get(c);
        if (info?.source === "derived") {
          await upsertBalanceSnapshot(tx, user, { accountId: a.account.id, asOf: today, balanceMinor: v, currency: c, source: "derived", raw: { startingOn: info.asOf } });
          n += 1;
        } else if (!existing.has(key)) {
          const l = latest.get(key);
          if (!l) continue;
          await upsertBalanceSnapshot(tx, user, {
            accountId: a.account.id,
            asOf: today,
            balanceMinor: v,
            currency: c,
            source: l.source,
            raw: { carriedFrom: parseSnapshotRaw(l.raw).carriedFrom ?? l.asOf },
          });
          n += 1;
        }
      }
    }
    await tx.insert(jobs)
      .values({ userId: user.id, name: BALANCE_SNAPSHOT_JOB, status: "idle", cursor: today })
      .onConflictDoUpdate({ target: [jobs.userId, jobs.name], set: { cursor: today, status: "idle", lastError: null } });
    return n;
  });
}
