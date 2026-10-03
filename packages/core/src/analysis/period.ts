import { LedgerError } from "../ledger/errors";
import { assertRange, type DateRange, isStatsPreset, monthRangeOf, presetRange, previousRange, STATS_PRESETS, wholeMonths } from "../stats/period";
import { addDays, isDate, weekdayOf } from "../time/day";

// Day, week, month and year periods for Analysis, on 'YYYY-MM-DD' strings. Pure.

export type PeriodKind = "day" | "week" | "month" | "year";

/** Analysis presets: the day and week ones, then the Stats presets (months, quarters, years). */
export const ANALYSIS_PRESETS = ["yesterday", "today", "this_week", "last_week", ...STATS_PRESETS] as const;
export type AnalysisPreset = (typeof ANALYSIS_PRESETS)[number];

/** Weeks start on Monday (ISO) until a setting exists. 0 = Sunday ... 6 = Saturday. */
export const DEFAULT_WEEK_START = 1;

/** Complete periods of the same kind that make up "typical": 28 days, 4 weeks, 3 months, 3 years. */
export const TYPICAL_PERIODS: Record<PeriodKind, number> = { day: 28, week: 4, month: 3, year: 3 };

export function isAnalysisPreset(s: unknown): s is AnalysisPreset {
  return typeof s === "string" && (ANALYSIS_PRESETS as readonly string[]).includes(s);
}

function assertDate(date: string): void {
  if (!isDate(date)) throw new LedgerError("invalid", "invalid_date", `Invalid date: ${date}`, { value: date });
}

/** The seven days containing `date`, starting on `weekStart`. */
export function weekOf(date: string, weekStart: number = DEFAULT_WEEK_START): DateRange {
  assertDate(date);
  const back = (weekdayOf(date) - weekStart + 7) % 7;
  const from = addDays(date, -back);
  return { from, to: addDays(from, 6) };
}

/** The day, week, month or year containing `date`. */
export function periodOf(kind: PeriodKind, date: string, weekStart: number = DEFAULT_WEEK_START): DateRange {
  assertDate(date);
  if (kind === "day") return { from: date, to: date };
  if (kind === "week") return weekOf(date, weekStart);
  if (kind === "year") return { from: `${date.slice(0, 4)}-01-01`, to: `${date.slice(0, 4)}-12-31` };
  return monthRangeOf(date.slice(0, 7));
}

/** What a range is: one day, one week starting on `weekStart`, one calendar month or year, or any other range. */
export function periodKindOf(r: DateRange, weekStart: number = DEFAULT_WEEK_START): PeriodKind | "range" {
  if (r.from === r.to) return "day";
  if (wholeMonths(r) === 1) return "month";
  if (wholeMonths(r) === 12 && r.from.slice(5) === "01-01") return "year";
  if (weekdayOf(r.from) === weekStart && addDays(r.from, 6) === r.to) return "week";
  return "range";
}

/**
 * The period a kind opens on: Day opens on yesterday, the last day every daily source can have complete (today is
 * one step forward); Week, Month and Year open on the one containing today.
 */
export function defaultPeriod(kind: PeriodKind, today: string, weekStart: number = DEFAULT_WEEK_START): DateRange {
  return periodOf(kind, kind === "day" ? addDays(today, -1) : today, weekStart);
}

export function analysisPresetRange(preset: AnalysisPreset, today: string, weekStart: number = DEFAULT_WEEK_START): DateRange {
  assertDate(today);
  if (isStatsPreset(preset)) return presetRange(preset, today);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return periodOf("day", addDays(today, -1));
    case "this_week":
      return weekOf(today, weekStart);
    case "last_week":
      return weekOf(addDays(today, -7), weekStart);
  }
}

/** The preset whose range equals `r` on `today`, else "custom". */
export function matchAnalysisPreset(r: DateRange, today: string, weekStart: number = DEFAULT_WEEK_START): AnalysisPreset | "custom" {
  return (
    ANALYSIS_PRESETS.find((p) => {
      const x = analysisPresetRange(p, today, weekStart);
      return x.from === r.from && x.to === r.to;
    }) ?? "custom"
  );
}

export type AnalysisPeriodInput =
  | { period: PeriodKind; date?: string }
  | { preset: AnalysisPreset }
  | { from: string; to: string };

/**
 * The range an Analysis request names: the day, week or month containing `date` (default: the period the kind opens
 * on, see defaultPeriod), a preset, or a plain range (validated: real dates, from ≤ to, at most five years).
 */
export function resolveAnalysisPeriod(input: AnalysisPeriodInput, today: string, weekStart: number = DEFAULT_WEEK_START): DateRange {
  assertDate(today);
  if ("period" in input) return input.date === undefined ? defaultPeriod(input.period, today, weekStart) : periodOf(input.period, input.date, weekStart);
  if ("preset" in input) return analysisPresetRange(input.preset, today, weekStart);
  const r = { from: input.from, to: input.to };
  assertRange(r);
  return r;
}

/**
 * The complete periods of the same kind just before `r`, oldest first: 28 days, 4 weeks, 3 months or 3 years. A plain
 * range has none.
 */
export function typicalRanges(r: DateRange, kind: PeriodKind | "range"): DateRange[] {
  if (kind === "range") return [];
  const out: DateRange[] = [];
  let p = r;
  for (let i = 0; i < TYPICAL_PERIODS[kind]; i++) {
    p = previousRange(p);
    out.unshift(p);
  }
  return out;
}
