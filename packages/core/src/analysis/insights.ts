import { countsAsSpending } from "../ledger/share";
import type { SpendingRow } from "../ledger/transactions";
import type { InvestFlow } from "../assets/investments";
import type { DateRange } from "../stats/period";
import { addDays, daysInclusive } from "../time/day";

// Numbers-only observations over spending rows (my share, ledger/share.ts rule). Pure: rows in, plain data out.

/** The fields the observations read; SpendingRow has them all. */
export type AnalysisRow = Pick<
  SpendingRow,
  "id" | "occurredOn" | "occurredAt" | "amountMinor" | "currency" | "kind" | "status" | "duplicateOfId" | "provisional" | "merchant" | "categoryId" | "source" | "myShareMinor"
>;

const SHIFT_FLOOR: Record<string, number> = { USD: 2000, CNY: 10000 };
const DEFAULT_SHIFT_FLOOR = 2000;

/** Smallest change worth a line (category shifts, unusual rows), in minor units: $20, ¥100. */
export function shiftFloor(currency: string): number {
  return SHIFT_FLOOR[currency] ?? DEFAULT_SHIFT_FLOOR;
}

const inRange = (day: string, r: DateRange) => day >= r.from && day <= r.to;
const spendIn = (rows: readonly AnalysisRow[], currency: string) => rows.filter((r) => r.currency === currency && countsAsSpending(r));
/** A purchase that cost me something (refunds and fully shared rows aside). */
const isCharge = (r: AnalysisRow) => r.kind === "expense" && r.myShareMinor > 0;
/** Manual entries name what was bought, not a merchant: they are never "new" or judged against a merchant's history. */
const isImported = (r: AnalysisRow) => r.source !== "manual";
/** A provisional capture is not judged: its statement row would flag the same charge again, and a hold's amount is not final. */
const isFinal = (r: AnalysisRow) => r.provisional == null;
const merchantKey = (m: string) => m.trim().toLowerCase();

export interface Typical {
  /** Complete periods it averages over (empty ones count as 0). */
  periods: number;
  /** Mean spending per period. */
  perPeriodMinor: number;
  /** Mean spending per day over the same periods. */
  dailyMinor: number;
}

/**
 * Typical spending in `currency` over `ranges` (the previous complete periods of the same kind). Periods that start
 * before the currency's first spending day (`since`) do not count; with fewer than 2 left there is no typical value.
 */
export function typicalSpending(rows: readonly AnalysisRow[], ranges: readonly DateRange[], currency: string, since: string | null): Typical | null {
  if (since == null) return null;
  const usable = ranges.filter((r) => r.from >= since);
  if (usable.length < 2) return null;
  const spend = spendIn(rows, currency);
  let total = 0;
  let days = 0;
  for (const r of usable) {
    total += spend.filter((x) => inRange(x.occurredOn, r)).reduce((a, x) => a + x.myShareMinor, 0);
    days += daysInclusive(r.from, r.to);
  }
  return { periods: usable.length, perPeriodMinor: Math.round(total / usable.length), dailyMinor: Math.round(total / days) };
}

export interface MerchantTotal {
  merchant: string;
  minor: number;
  count: number;
  /** Share of the period's spending in basis points (10000 = 100%). */
  share: number;
}

/** Merchants by my spending in `currency`, largest first (ties: more rows, then name); only positive totals. */
export function topMerchants(rows: readonly AnalysisRow[], currency: string, limit = 5): MerchantTotal[] {
  const spend = spendIn(rows, currency);
  const total = spend.reduce((a, r) => a + r.myShareMinor, 0);
  const groups = new Map<string, MerchantTotal>();
  for (const r of spend) {
    const name = r.merchant.trim();
    if (!name) continue;
    const g = groups.get(merchantKey(name)) ?? { merchant: name, minor: 0, count: 0, share: 0 };
    g.minor += r.myShareMinor;
    g.count += 1;
    groups.set(merchantKey(name), g);
  }
  return [...groups.values()]
    .filter((g) => g.minor > 0)
    .map((g) => ({ ...g, share: total > 0 ? Math.round((g.minor * 10000) / total) : 0 }))
    .sort((a, b) => b.minor - a.minor || b.count - a.count || a.merchant.localeCompare(b.merchant))
    .slice(0, limit);
}

export interface CategoryAmount {
  categoryId: number | null;
  name: string;
  minor: number;
}

export interface CategoryShift {
  categoryId: number | null;
  name: string;
  currentMinor: number;
  typicalMinor: number;
  /** current − typical. */
  deltaMinor: number;
}

/**
 * Up to `limit` categories whose spending moved most against typical (both for the same number of days): at least
 * 20% of typical and at least the shift floor. Largest absolute change first.
 */
export function categoryShifts(current: readonly CategoryAmount[], typical: readonly CategoryAmount[], currency: string, limit = 3): CategoryShift[] {
  const floor = shiftFloor(currency);
  const all = new Map<number | null, CategoryShift>();
  for (const c of current) all.set(c.categoryId, { categoryId: c.categoryId, name: c.name, currentMinor: c.minor, typicalMinor: 0, deltaMinor: 0 });
  for (const c of typical) {
    const s = all.get(c.categoryId) ?? { categoryId: c.categoryId, name: c.name, currentMinor: 0, typicalMinor: 0, deltaMinor: 0 };
    s.typicalMinor = c.minor;
    all.set(c.categoryId, s);
  }
  return [...all.values()]
    .map((s) => ({ ...s, deltaMinor: s.currentMinor - s.typicalMinor }))
    .filter((s) => Math.abs(s.deltaMinor) >= floor && (s.typicalMinor <= 0 || Math.abs(s.deltaMinor) * 5 >= s.typicalMinor))
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Days of history a merchant is judged against. */
export const UNUSUAL_LOOKBACK_DAYS = 180;
/** "First large" needs this much history in the currency before the row, so a fresh ledger flags nothing. */
export const FIRST_LARGE_MIN_HISTORY_DAYS = 60;

interface UnusualBase {
  id: number;
  merchant: string;
  /** My share of the row. */
  minor: number;
  occurredOn: string;
  source: string;
}

export type UnusualItem =
  | (UnusualBase & { kind: "larger_than_usual"; /** Median of the merchant's earlier charges. */ usualMinor: number })
  | (UnusualBase & { kind: "first_large" })
  | (UnusualBase & { kind: "possible_duplicate"; otherId: number; otherSource: string });

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Rows in the period worth a second look, at most `limit`, largest first:
 * - `larger_than_usual`: the merchant has 3 or more charges in the 180 days before, and this one is at least twice
 *   their median and at least the shift floor;
 * - `first_large`: no charge from the merchant in the 180 days before, at least 5 times the shift floor, and the
 *   currency has at least 60 days of history (`since`);
 * - `possible_duplicate`: same merchant, amount and day as another counted row from a different source and not
 *   linked to it (a missed cross-source link; repeats within one source are legitimate).
 * Manual entries can be a duplicate but are never judged against a merchant's history.
 * `history` holds the rows of the 180 days before the period (rows of the period itself may be included).
 */
export function unusualItems(
  period: readonly AnalysisRow[],
  history: readonly AnalysisRow[],
  currency: string,
  opts: { since?: string | null; limit?: number } = {},
): UnusualItem[] {
  const floor = shiftFloor(currency);
  const charges = spendIn(period, currency).filter((r) => isCharge(r) && isFinal(r));
  const byMerchant = new Map<string, AnalysisRow[]>();
  for (const r of spendIn(history, currency).filter(isCharge)) {
    const k = merchantKey(r.merchant);
    if (!k) continue;
    byMerchant.set(k, [...(byMerchant.get(k) ?? []), r]);
  }
  const out = new Map<number, UnusualItem>();
  const base = (r: AnalysisRow): UnusualBase => ({ id: r.id, merchant: r.merchant, minor: r.myShareMinor, occurredOn: r.occurredOn, source: r.source });

  // Duplicates first: they win over the other kinds for the same row.
  const sameDay = new Map<string, AnalysisRow[]>();
  for (const r of charges) {
    const k = merchantKey(r.merchant);
    if (!k) continue;
    const key = `${k}|${r.amountMinor}|${r.occurredOn}`;
    sameDay.set(key, [...(sameDay.get(key) ?? []), r]);
  }
  for (const group of sameDay.values()) {
    const sorted = [...group].sort((a, b) => a.id - b.id);
    for (let i = 1; i < sorted.length; i++) {
      const other = sorted.slice(0, i).find((o) => o.source !== sorted[i]!.source);
      if (other) out.set(sorted[i]!.id, { ...base(sorted[i]!), kind: "possible_duplicate", otherId: other.id, otherSource: other.source });
    }
  }

  for (const r of charges.filter(isImported)) {
    if (out.has(r.id)) continue;
    const k = merchantKey(r.merchant);
    if (!k) continue;
    const start = addDays(r.occurredOn, -UNUSUAL_LOOKBACK_DAYS);
    const prior = (byMerchant.get(k) ?? []).filter((x) => x.occurredOn >= start && x.occurredOn < r.occurredOn).map((x) => x.myShareMinor);
    if (prior.length >= 3) {
      const usual = median(prior);
      if (r.myShareMinor >= 2 * usual && r.myShareMinor >= floor) out.set(r.id, { ...base(r), kind: "larger_than_usual", usualMinor: usual });
    } else if (prior.length === 0 && r.myShareMinor >= 5 * floor && opts.since != null && opts.since <= addDays(r.occurredOn, -FIRST_LARGE_MIN_HISTORY_DAYS)) {
      out.set(r.id, { ...base(r), kind: "first_large" });
    }
  }
  return [...out.values()].sort((a, b) => b.minor - a.minor || a.id - b.id).slice(0, opts.limit ?? 5);
}

export interface NewMerchant {
  merchant: string;
  /** My spending there in the period. */
  minor: number;
  count: number;
  /** First day in the period. */
  firstOn: string;
}

/**
 * Merchants charged in the period with no charge in the 180 days before their first one here, largest first, at most
 * `limit`. Needs 60 days of history in the currency before that first charge (`since`), so a fresh ledger lists
 * nothing; manual entries are left out. `history` is as for unusualItems.
 */
export function newMerchants(
  period: readonly AnalysisRow[],
  history: readonly AnalysisRow[],
  currency: string,
  opts: { since?: string | null; limit?: number } = {},
): NewMerchant[] {
  if (opts.since == null) return [];
  const groups = new Map<string, NewMerchant>();
  for (const r of spendIn(period, currency).filter((x) => isCharge(x) && isImported(x) && isFinal(x)).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.id - b.id)) {
    const name = r.merchant.trim();
    if (!name) continue;
    const g = groups.get(merchantKey(name)) ?? { merchant: name, minor: 0, count: 0, firstOn: r.occurredOn };
    g.minor += r.myShareMinor;
    g.count += 1;
    groups.set(merchantKey(name), g);
  }
  const charges = spendIn(history, currency).filter(isCharge);
  return [...groups.entries()]
    .filter(([key, g]) => {
      if (opts.since! > addDays(g.firstOn, -FIRST_LARGE_MIN_HISTORY_DAYS)) return false;
      const start = addDays(g.firstOn, -UNUSUAL_LOOKBACK_DAYS);
      return !charges.some((x) => merchantKey(x.merchant) === key && x.occurredOn >= start && x.occurredOn < g.firstOn);
    })
    .map(([, g]) => g)
    .sort((a, b) => b.minor - a.minor || a.merchant.localeCompare(b.merchant))
    .slice(0, opts.limit ?? 5);
}

export interface InvestmentChange {
  currency: string;
  /** Holdings value at the end of the day before the period; null when unknown then. */
  startMinor: number | null;
  /** Holdings value at the end of the period (or today); null when unknown. */
  endMinor: number | null;
  /** end − start; null when either is unknown. */
  changeMinor: number | null;
  /** Cash deposited (positive) or withdrawn in the period. */
  netDepositsMinor: number;
  /** change − net deposits: what the market (and dividends, fees) did; null when the change is unknown or partial. */
  marketMinor: number | null;
  dividendCount: number;
  /** Some investment account in this currency has no value on one of the two days. */
  partial: boolean;
}

/** Splits a holdings change into deposits and market movement for one currency. */
export function splitInvestmentChange(
  startMinor: number | null,
  endMinor: number | null,
  flows: readonly Pick<InvestFlow, "type" | "amountMinor" | "currency">[],
  currency: string,
  partial = false,
): InvestmentChange {
  const mine = flows.filter((f) => f.currency === currency);
  const netDepositsMinor = mine.filter((f) => f.type === "transfer").reduce((a, f) => a + f.amountMinor, 0);
  const changeMinor = startMinor != null && endMinor != null ? endMinor - startMinor : null;
  return {
    currency,
    startMinor,
    endMinor,
    changeMinor,
    netDepositsMinor,
    marketMinor: changeMinor != null && !partial ? changeMinor - netDepositsMinor : null,
    dividendCount: mine.filter((f) => f.type === "dividend").length,
    partial,
  };
}
