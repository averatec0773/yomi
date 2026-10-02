import { bankAccounts, bankConnections, type Db, holdingSnapshots, importBatches, investmentAccounts, transactions } from "@yomi/db";
import { and, count, eq, gte, inArray, isNotNull, lte, max, ne } from "@yomi/db/orm";
import { ibkrStatus } from "../invest/status";
import { lastCompletedTradingDay } from "../invest/time";
import { countsAsIncome, countsAsSpending } from "../ledger/share";
import type { SpendingRow } from "../ledger/transactions";
import { clockNow } from "../time/clock";
import { addDays, type DateRange, daysInclusive } from "../stats/period";
import { localDate } from "../time/zone";
import type { CurrentUser } from "../user";

// How far each source's data reaches, and which currencies of a period it leaves incomplete.

/** Statement exports the author downloads by hand; each file states the days it covers. */
export const EXPORT_SOURCES = ["alipay", "wechat", "icbc_pdf", "boa_csv"] as const;
export type ExportSource = (typeof EXPORT_SOURCES)[number];

export type FreshnessSource = ExportSource | "plaid" | "sms" | "ibkr" | "plaid_investments";

/**
 * stream: pulled on a schedule (Plaid transactions); export: files (Alipay, WeChat, ICBC, BoA); capture: pasted one
 * by one (SMS), which shows the pipe is alive, never completeness; investments: holdings sources (IBKR, Plaid brokerages).
 */
export type SourceKind = "stream" | "export" | "capture" | "investments";

export interface SourceFacts {
  /** Stable id: the source, or `plaid:<connection id>` / `plaid_investments:<connection id>` for one Plaid login. */
  key: string;
  source: FreshnessSource;
  kind: SourceKind;
  /** Institution name of a Plaid login; null otherwise. */
  label: string | null;
  /** Last day the source's data is complete through; null when nothing is known. */
  through: string | null;
  /** capture: the last day something was captured. */
  lastOn: string | null;
  status: "active" | "paused" | "error" | "waiting";
  /** Stable code of the failure when `status` is error. */
  errorCode: string | null;
  /** investments: the trading day whose data should be out by now. */
  expectedThrough: string | null;
  /** Currencies of the source's ledger rows. */
  currencies: string[];
}

export type FreshnessState = "current" | "behind" | "error" | "paused" | "never";

export interface SourceFreshness extends SourceFacts {
  state: FreshnessState;
  /** An export older than a week (or never imported): a new file is due. */
  exportReminder: boolean;
}

/** An export counts as due for a new file after this many days. */
export const EXPORT_REMINDER_DAYS = 7;

/**
 * The state of each source on `today`. Streams and exports are behind when their data ends before yesterday (the
 * last day that can be complete); investments when it ends before the trading day that should be out. Captures are
 * always current: they show activity, not completeness.
 */
export function sourceFreshness(facts: readonly SourceFacts[], today: string): SourceFreshness[] {
  const yesterday = addDays(today, -1);
  return facts.map((f) => {
    const expected = f.kind === "investments" ? (f.expectedThrough ?? yesterday) : yesterday;
    const state: FreshnessState =
      f.kind === "capture"
        ? "current"
        : f.status === "error"
          ? "error"
          : f.status === "paused"
            ? "paused"
            : f.through == null
              ? "never"
              : f.through < expected || f.status === "waiting"
                ? "behind"
                : "current";
    const exportReminder = f.kind === "export" && (f.through == null || daysInclusive(f.through, today) - 1 > EXPORT_REMINDER_DAYS);
    return { ...f, state, exportReminder };
  });
}

/** A source has ledger rows in this currency inside a period's activity window. */
export interface SourceActivity {
  key: string;
  currency: string;
}

/** A source counts for a period when it has rows from 90 days before the period through its end. */
export const ACTIVITY_WINDOW_DAYS = 90;

export function activityWindow(r: DateRange): DateRange {
  return { from: addDays(r.from, -ACTIVITY_WINDOW_DAYS), to: r.to };
}

/**
 * Per currency, the sources (keys) that leave the period incomplete: a stream or export source with rows of that
 * currency in the activity window whose data ends before min(period end, yesterday). Captures and investment
 * sources never make a spending period partial. Currencies with no such source are absent.
 */
export function periodCompleteness(fresh: readonly SourceFreshness[], activity: readonly SourceActivity[], r: DateRange, today: string): Record<string, string[]> {
  const yesterday = addDays(today, -1);
  const need = r.to < yesterday ? r.to : yesterday;
  const out: Record<string, string[]> = {};
  for (const f of fresh) {
    if (f.kind !== "stream" && f.kind !== "export") continue;
    if (f.through != null && f.through >= need) continue;
    for (const a of activity) {
      if (a.key !== f.key) continue;
      const list = (out[a.currency] ??= []);
      if (!list.includes(f.key)) list.push(f.key);
    }
  }
  return out;
}

export type Attention =
  | { kind: "plaid"; key: string; label: string | null; errorCode: string | null }
  | { kind: "ibkr"; key: string; state: "error" | "waiting"; errorCode: string | null; through: string | null; expectedThrough: string | null };

/** Sources that need the author: a failing Plaid login, IBKR failing or late. Each links to Settings > Connections. */
export function attentionItems(fresh: readonly SourceFreshness[]): Attention[] {
  const out: Attention[] = [];
  for (const f of fresh) {
    if ((f.source === "plaid" || f.source === "plaid_investments") && f.status === "error") {
      out.push({ kind: "plaid", key: f.key, label: f.label, errorCode: f.errorCode });
    } else if (f.source === "ibkr" && (f.status === "error" || f.status === "waiting")) {
      out.push({ kind: "ibkr", key: f.key, state: f.status, errorCode: f.errorCode, through: f.through, expectedThrough: f.expectedThrough });
    }
  }
  return out;
}

const SOURCE_ORDER: FreshnessSource[] = ["plaid", "alipay", "wechat", "icbc_pdf", "boa_csv", "sms", "ibkr", "plaid_investments"];

/**
 * What every source of the user's ledger knows about its own reach (no judgement; see sourceFreshness). `timeZone`
 * turns sync and capture instants into days; IBKR is read through ibkrStatus (`env` for its credentials, `now` for the
 * expected statement day). Manual entries are not a source here.
 */
export async function loadSourceFacts(db: Db, user: CurrentUser, opts: { timeZone: string; env?: NodeJS.ProcessEnv; now?: Date }): Promise<SourceFacts[]> {
  const userId = user.id;
  const out: SourceFacts[] = [];
  const base = { label: null, lastOn: null, status: "active" as const, errorCode: null, expectedThrough: null };

  // Currencies per ledger source, and the newest day of each source's rows.
  const bySource = await db
    .select({ source: transactions.source, currency: transactions.currency, last: max(transactions.occurredOn), lastAt: max(transactions.createdAt) })
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .groupBy(transactions.source, transactions.currency);
  const coverage = await db
    .select({ source: importBatches.source, end: max(importBatches.periodEnd) })
    .from(importBatches)
    .where(and(eq(importBatches.userId, userId), eq(importBatches.status, "committed")))
    .groupBy(importBatches.source);

  for (const source of EXPORT_SOURCES) {
    const rows = bySource.filter((r) => r.source === source);
    const end = coverage.find((c) => c.source === source)?.end ?? null;
    if (rows.length === 0 && end == null) continue;
    // A file covers at least its newest row, so the larger of the stated end and that row is the reach.
    const through = [end, ...rows.map((r) => r.last)].filter((d): d is string => d != null).sort().at(-1) ?? null;
    out.push({ ...base, key: source, source, kind: "export", through, currencies: [...new Set(rows.map((r) => r.currency))].sort() });
  }

  // Plaid logins: transactions arrive with a day's delay, so a sync covers through the day before it.
  const conns = await db
    .select()
    .from(bankConnections)
    .where(and(eq(bankConnections.userId, userId), ne(bankConnections.status, "disconnected")));
  if (conns.length > 0) {
    const accts = await db
      .select({ connectionId: bankAccounts.connectionId, currency: bankAccounts.currency })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.userId, userId), inArray(bankAccounts.connectionId, conns.map((c) => c.id))));
    const snaps = await db
      .select({ connectionId: investmentAccounts.bankConnectionId, asOf: max(holdingSnapshots.asOf) })
      .from(holdingSnapshots)
      .innerJoin(investmentAccounts, eq(investmentAccounts.id, holdingSnapshots.investmentAccountId))
      .where(and(eq(holdingSnapshots.userId, userId), isNotNull(investmentAccounts.bankConnectionId)))
      .groupBy(investmentAccounts.bankConnectionId);
    for (const c of conns) {
      const status = c.status === "error" ? "error" : c.status === "paused" ? "paused" : "active";
      const common = { ...base, label: c.institutionName, status, errorCode: c.status === "error" ? c.lastError : null } as const;
      if (c.kind === "brokerage") {
        const asOf = snaps.find((s) => s.connectionId === c.id)?.asOf ?? null;
        out.push({
          ...common,
          key: `plaid_investments:${c.id}`,
          source: "plaid_investments",
          kind: "investments",
          through: asOf,
          expectedThrough: lastCompletedTradingDay(opts.now ?? clockNow()),
          currencies: [],
        });
      } else {
        const through = c.lastSyncedAt ? addDays(localDate(c.lastSyncedAt, opts.timeZone), -1) : null;
        const currencies = [...new Set(accts.filter((a) => a.connectionId === c.id).map((a) => a.currency))].sort();
        out.push({ ...common, key: `plaid:${c.id}`, source: "plaid", kind: "stream", through, currencies });
      }
    }
  }

  const sms = bySource.filter((r) => r.source === "sms");
  if (sms.length > 0) {
    const lastAt = sms.map((r) => r.lastAt).filter((d): d is string => d != null).sort().at(-1) ?? null;
    out.push({ ...base, key: "sms", source: "sms", kind: "capture", through: null, lastOn: lastAt ? localDate(lastAt, opts.timeZone) : null, currencies: [...new Set(sms.map((r) => r.currency))].sort() });
  }

  const ibkr = await ibkrStatus(db, user, opts.env, opts.now);
  if (ibkr.configured || ibkr.lastStatementDate != null) {
    out.push({
      ...base,
      key: "ibkr",
      source: "ibkr",
      kind: "investments",
      through: ibkr.lastStatementDate,
      status: ibkr.state === "error" ? "error" : ibkr.state === "waiting" ? "waiting" : "active",
      errorCode: ibkr.errorCode,
      expectedThrough: ibkr.expectedAsOf,
      currencies: [],
    });
  }

  return out.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.key.localeCompare(b.key));
}

/** Ledger account id → `plaid:<connection id>` of the Plaid login the account is linked to. */
export async function loadPlaidLogins(db: Db, user: CurrentUser): Promise<Map<number, string>> {
  const rows = await db
    .select({ accountId: bankAccounts.accountId, connectionId: bankAccounts.connectionId })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.userId, user.id), isNotNull(bankAccounts.accountId)));
  return new Map(rows.map((a) => [a.accountId!, `plaid:${a.connectionId}`]));
}

/**
 * Which sources have rows of which currency in the period's activity window (90 days before through its end). Plaid
 * rows count for the login their account is linked to; a provisional card alert counts for the ICBC statement that is
 * still to confirm it (a week with only alerts is partial until the statement reaches it).
 */
export async function loadSourceActivity(db: Db, user: CurrentUser, r: DateRange): Promise<SourceActivity[]> {
  const w = activityWindow(r);
  const rows = await db
    .select({ source: transactions.source, provisional: transactions.provisional, accountId: transactions.accountId, currency: transactions.currency, n: count() })
    .from(transactions)
    .where(and(eq(transactions.userId, user.id), gte(transactions.occurredOn, w.from), lte(transactions.occurredOn, w.to)))
    .groupBy(transactions.source, transactions.provisional, transactions.accountId, transactions.currency);
  const logins = await loadPlaidLogins(db, user);
  const out = new Map<string, SourceActivity>();
  for (const row of rows) {
    const key =
      row.source === "plaid"
        ? row.accountId != null
          ? logins.get(row.accountId)
          : undefined
        : row.source === "sms" && row.provisional != null
          ? "icbc_pdf"
          : row.source;
    if (key) out.set(`${key}|${row.currency}`, { key, currency: row.currency });
  }
  return [...out.values()];
}

/** One source's part of a period's numbers in one currency, by the summary card's rules (ledger/share.ts). */
export interface SourceTotal {
  /** The freshness key (`plaid:<connection id>` for a linked Plaid account), else the ledger source ("manual"). */
  key: string;
  source: string;
  currency: string;
  /** Rows counted as spending; a linked pair counts once, on the row the ledger keeps. */
  count: number;
  /** Σ my share of those rows. */
  spendingMinor: number;
  incomeCount: number;
  incomeMinor: number;
}

/**
 * Per source and currency, the rows the summary card counts. Linked duplicates never count, so the counts and
 * spending add up to the card's transaction count and spending per currency. `logins` from loadPlaidLogins.
 */
export function sourceTotals(rows: readonly SpendingRow[], logins: ReadonlyMap<number, string>): SourceTotal[] {
  const out = new Map<string, SourceTotal>();
  for (const r of rows) {
    const spends = countsAsSpending(r);
    if (!spends && !countsAsIncome(r)) continue;
    const key = (r.source === "plaid" && r.accountId != null ? logins.get(r.accountId) : undefined) ?? r.source;
    const id = `${key}|${r.currency}`;
    const t = out.get(id) ?? { key, source: r.source, currency: r.currency, count: 0, spendingMinor: 0, incomeCount: 0, incomeMinor: 0 };
    if (spends) {
      t.count += 1;
      t.spendingMinor += r.myShareMinor;
    } else {
      t.incomeCount += 1;
      t.incomeMinor += r.amountMinor;
    }
    out.set(id, t);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency));
}
