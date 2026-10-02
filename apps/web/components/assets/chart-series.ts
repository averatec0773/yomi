// Daily series of the Assets history charts, assembled from the net worth history. Pure; unknown days stay null
// (never zero), so every line starts on its own first known day.
import type { InvestFlow, MissingAccount, NetWorth, NetWorthPart, NetWorthParts } from "@yomi/core";

export interface ChartDay {
  date: string;
  /** The day's parts in the chart currency; null when nothing is known. */
  parts: NetWorthParts | null;
  known: ReadonlySet<NetWorthPart>;
  /** Accounts known later but not yet on this day (the day's net worth is partial). */
  missing: Pick<MissingAccount, "name" | "kind">[];
}

/**
 * The history in one currency: converted parts when `nw.converted` exists (every currency, every missing
 * account), else that currency's parts and the missing accounts that hold it. Converted, cash, cards and
 * holdings are known when any currency knows them, P/L only when every currency with holdings knows it.
 */
export function chartDays(nw: Pick<NetWorth, "series" | "converted">, currency: string): ChartDay[] {
  return nw.series.map((p) => {
    if (nw.converted) {
      const lists = Object.values(p.known);
      const known = new Set<NetWorthPart>(lists.flat().filter((x) => x !== "pnl"));
      if (lists.some((l) => l.includes("holdings")) && lists.every((l) => !l.includes("holdings") || l.includes("pnl"))) known.add("pnl");
      return { date: p.date, parts: Object.keys(p.byCurrency).length ? p.converted : null, known, missing: p.missing.map(({ name, kind }) => ({ name, kind })) };
    }
    return {
      date: p.date,
      parts: p.byCurrency[currency] ?? null,
      known: new Set(p.known[currency] ?? []),
      missing: p.missing.filter((m) => m.currencies.includes(currency)).map(({ name, kind }) => ({ name, kind })),
    };
  });
}

const pick = (days: ChartDay[], part: NetWorthPart, value: (p: NetWorthParts) => number) =>
  days.map((d) => (d.parts && d.known.has(part) ? value(d.parts) : null));

export interface AllSeries {
  netWorth: (number | null)[];
  /** Net worth leaves out an account that is known later. */
  partial: boolean[];
  cash: (number | null)[];
  investments: (number | null)[];
  /** Card balances owed (negative). */
  cards: (number | null)[];
}

/** All view: net worth (partial where an account known later has no value yet), cash, investments, cards. */
export function allSeries(days: ChartDay[]): AllSeries {
  const netWorth = days.map((d) => (d.parts && d.known.size > 0 ? d.parts.totalMinor : null));
  return {
    netWorth,
    partial: days.map((d, i) => netWorth[i] != null && d.missing.length > 0),
    cash: pick(days, "cash", (p) => p.cashMinor),
    investments: pick(days, "holdings", (p) => p.holdingsMinor),
    cards: pick(days, "cards", (p) => p.cardsMinor),
  };
}

/** Cash view: cash plus card balances, on days either is known. */
export function netCashSeries(days: ChartDay[]): (number | null)[] {
  return days.map((d) => (d.parts && (d.known.has("cash") || d.known.has("cards")) ? d.parts.cashMinor + d.parts.cardsMinor : null));
}

/** Investments view: market value, or unrealized P/L on days every value comes with its positions. */
export function investSeries(days: ChartDay[], kind: "value" | "pnl"): (number | null)[] {
  return kind === "pnl" ? pick(days, "pnl", (p) => p.pnlMinor) : pick(days, "holdings", (p) => p.holdingsMinor);
}

/** Days whose investments value leaves out an investment account that is known later. */
export function investPartial(days: ChartDay[], values: readonly (number | null)[]): boolean[] {
  return days.map((d, i) => values[i] != null && d.missing.some((m) => m.kind === "investment"));
}

/** The names of the accounts a day lacks, of one kind or all. */
export function missingNames(days: ChartDay[], kind?: MissingAccount["kind"]): string[][] {
  return days.map((d) => d.missing.filter((m) => !kind || m.kind === kind).map((m) => m.name));
}

/** A flow's amount in the chart currency: converted when the chart is, else only flows already in it. */
function flowAmount(f: InvestFlow, currency: string, converted: boolean): number | null {
  if (converted) return f.convertedMinor;
  return f.currency === currency ? f.amountMinor : null;
}

/**
 * Net deposits as a line comparable with the market value: it starts at the value on the anchor day and moves
 * only by cash deposited or withdrawn after it, so the gap between the two lines is market gain or loss since
 * the anchor (dividends, interest and fees included). The anchor is the first day with a value that is not
 * partial (an account appearing later would otherwise read as a gain). Null without an anchor, or when a
 * deposit cannot be stated in the chart currency.
 */
export function netDepositsSeries(
  dates: readonly string[],
  values: readonly (number | null)[],
  flows: readonly InvestFlow[],
  currency: string,
  converted: boolean,
  partial: readonly boolean[] = [],
): { values: (number | null)[]; from: string } | null {
  const a = values.findIndex((v, i) => v != null && !partial[i]);
  if (a < 0) return null;
  const byDay = new Map<string, number>();
  for (const f of flows) {
    if (f.type !== "transfer" || f.date <= dates[a]!) continue;
    const amount = flowAmount(f, currency, converted);
    if (amount == null) return null;
    byDay.set(f.date, (byDay.get(f.date) ?? 0) + amount);
  }
  let level = values[a]!;
  return {
    from: dates[a]!,
    values: dates.map((d, i) => {
      if (i < a) return null;
      level += i > a ? (byDay.get(d) ?? 0) : 0;
      return level;
    }),
  };
}

export interface FlowMarker {
  /** Day index in the series. */
  index: number;
  items: { type: "buy" | "sell" | "dividend"; symbol: string | null; amountMinor: number; currency: string }[];
}

/** Trades and dividends grouped by day, on days the value line has a value (amounts as stored, own currency). */
export function flowMarkers(dates: readonly string[], values: readonly (number | null)[], flows: readonly InvestFlow[]): FlowMarker[] {
  const at = new Map(dates.map((d, i) => [d, i]));
  const out = new Map<number, FlowMarker>();
  for (const f of flows) {
    if (f.type === "transfer") continue;
    const i = at.get(f.date);
    if (i == null || values[i] == null) continue;
    let m = out.get(i);
    if (!m) out.set(i, (m = { index: i, items: [] }));
    m.items.push({ type: f.type, symbol: f.symbol, amountMinor: f.amountMinor, currency: f.currency });
  }
  return [...out.values()].sort((x, y) => x.index - y.index);
}
