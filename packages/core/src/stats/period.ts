import { LedgerError } from "../ledger/errors";
import { addDays, daysInclusive, isDate, monthEnd, monthStart, shiftMonth } from "../time/day";

// Stats ranges and presets on 'YYYY-MM-DD' strings (calendar dates, no time zone). Pure.

export interface DateRange {
  /** First day, inclusive. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

export const STATS_PRESETS = ["this_month", "last_month", "last_3_months", "last_6_months", "this_year", "last_year"] as const;
export type StatsPreset = (typeof STATS_PRESETS)[number];

/** Longest range the stats accept, in calendar years (from + 5 years, exclusive). */
export const MAX_RANGE_YEARS = 5;

export function monthRangeOf(month: string): DateRange {
  return { from: monthStart(month), to: monthEnd(month) };
}

/** Throws invalid_input unless both ends are real dates, from ≤ to and the span is at most five years. */
export function assertRange(r: DateRange): void {
  if (!isDate(r.from)) throw new LedgerError("invalid", "invalid_start_date", `Invalid start date: ${r.from}`, { value: r.from });
  if (!isDate(r.to)) throw new LedgerError("invalid", "invalid_end_date", `Invalid end date: ${r.to}`, { value: r.to });
  if (r.from > r.to) throw new LedgerError("invalid", "range_start_after_end", "The start date cannot be after the end date");
  const year = String(Number(r.from.slice(0, 4)) + MAX_RANGE_YEARS).padStart(4, "0");
  // A range from Feb 29 may end on Feb 28 five years later.
  const end = isDate(`${year}${r.from.slice(4)}`) ? `${year}${r.from.slice(4)}` : `${year}-03-01`;
  if (r.to >= end) throw new LedgerError("invalid", "range_too_long", "A range can be at most 5 years", { years: 5 });
}

/** Number of whole calendar months the range covers exactly, or null when it does not start on a 1st and end on a month end. */
export function wholeMonths(r: DateRange): number | null {
  if (r.from.slice(8) !== "01" || r.to !== monthEnd(r.to.slice(0, 7))) return null;
  const [fy, fm] = r.from.split("-").map(Number) as [number, number];
  const [ty, tm] = r.to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm) + 1;
}

/**
 * The period just before `r`, of equal length. Whole-month ranges step back by the same number of
 * calendar months (September compares with August, a year with the year before); any other range
 * steps back by the same number of days.
 */
export function previousRange(r: DateRange): DateRange {
  const months = wholeMonths(r);
  if (months != null) {
    const start = shiftMonth(r.from.slice(0, 7), -months);
    return { from: monthStart(start), to: monthEnd(shiftMonth(r.from.slice(0, 7), -1)) };
  }
  const len = daysInclusive(r.from, r.to);
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}

/** Calendar months the range touches, oldest first ('YYYY-MM'). */
export function monthsIn(r: DateRange): string[] {
  const out: string[] = [];
  const last = r.to.slice(0, 7);
  for (let m = r.from.slice(0, 7); m <= last; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/**
 * Resolves a preset against `today`. Ranges that contain today keep their calendar bounds
 * (this month is the whole month; the last 3 months are this month and the two before it; this year is the whole year).
 */
export function presetRange(preset: StatsPreset, today: string): DateRange {
  if (!isDate(today)) throw new LedgerError("invalid", "invalid_date", `Invalid date: ${today}`, { value: today });
  const month = today.slice(0, 7);
  const year = today.slice(0, 4);
  switch (preset) {
    case "this_month":
      return monthRangeOf(month);
    case "last_month":
      return monthRangeOf(shiftMonth(month, -1));
    case "last_3_months":
      return { from: monthStart(shiftMonth(month, -2)), to: monthEnd(month) };
    case "last_6_months":
      return { from: monthStart(shiftMonth(month, -5)), to: monthEnd(month) };
    case "this_year":
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case "last_year": {
      const y = String(Number(year) - 1).padStart(4, "0");
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
  }
}

export function isStatsPreset(s: unknown): s is StatsPreset {
  return typeof s === "string" && (STATS_PRESETS as readonly string[]).includes(s);
}

/** A preset, or a custom range (validated), resolved to dates. */
export function resolvePeriod(input: { preset: StatsPreset } | { preset: "custom"; from: string; to: string }, today: string): DateRange {
  if (input.preset === "custom") {
    const r = { from: input.from, to: input.to };
    assertRange(r);
    return r;
  }
  return presetRange(input.preset, today);
}

/** The preset whose range equals `r` on `today`, else "custom". */
export function matchPreset(r: DateRange, today: string): StatsPreset | "custom" {
  return STATS_PRESETS.find((p) => {
    const x = presetRange(p, today);
    return x.from === r.from && x.to === r.to;
  }) ?? "custom";
}

/**
 * The range one step before (`-1`) or after (`1`) `r`, by its own unit: whole-month ranges move by their number of
 * months (a month by a month, a quarter by three, a year by twelve); any other range by its length in days.
 */
export function shiftRange(r: DateRange, dir: -1 | 1): DateRange {
  const months = wholeMonths(r);
  if (months != null) {
    const start = shiftMonth(r.from.slice(0, 7), dir * months);
    return { from: monthStart(start), to: monthEnd(shiftMonth(start, months - 1)) };
  }
  const len = daysInclusive(r.from, r.to);
  return { from: addDays(r.from, dir * len), to: addDays(r.to, dir * len) };
}
