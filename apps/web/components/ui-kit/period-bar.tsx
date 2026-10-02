import {
  ANALYSIS_PRESETS,
  type AnalysisPreset,
  analysisPresetRange,
  type DateRange,
  matchAnalysisPreset,
  matchPreset,
  periodKindOf,
  presetRange,
  shiftRange,
  STATS_PRESETS,
  type StatsPreset,
  wholeMonths,
} from "@yomi/core";
import { getI18n } from "@/i18n/server";
import { rangeLabel } from "@/lib/period";
import { PeriodBarClient } from "./period-bar-client";

/** Which preset list the menu offers: the month-based Stats presets (Transactions), or those plus days and weeks (Analysis). */
export type PresetSet = "stats" | "analysis";

export interface PeriodBarProps {
  /** The page the links go to ("/transactions", "/analysis"). */
  path: string;
  /** The range on screen (resolve it with `resolvePagePeriod`). */
  range: DateRange;
  today: string;
  /** Other search params to keep on every link (filters); period params are dropped. */
  keep?: Record<string, string>;
  /** Plain-text problem with a custom range: opens the form with the message. */
  error?: string | null;
  /** Dates to refill the custom form with after an error. */
  typed?: { from: string; to: string };
  presets?: PresetSet;
  /** Label instead of the range's own ("Tue, Sep 29, 2026"). */
  label?: string;
  /** Next is disabled when the next period would start after this day (Analysis: today). */
  notAfter?: string;
}

const PERIOD_KEYS = new Set(["preset", "from", "to", "month"]);

interface Presets {
  list: readonly AnalysisPreset[];
  range: (p: AnalysisPreset, today: string) => DateRange;
  match: (r: DateRange, today: string) => AnalysisPreset | "custom";
}

function presetList(set: PresetSet): Presets {
  if (set === "analysis") return { list: ANALYSIS_PRESETS, range: (p, today) => analysisPresetRange(p, today), match: (r, today) => matchAnalysisPreset(r, today) };
  // The Stats list holds Stats presets only, so the narrowing below always holds.
  return { list: STATS_PRESETS, range: (p, today) => presetRange(p as StatsPreset, today), match: matchPreset };
}

/** `?preset=` when the range is a preset today, else `?from=&to=`, plus the kept params. */
export function periodHref(path: string, r: DateRange, today: string, keep: Record<string, string> = {}, presets: PresetSet = "stats"): string {
  const params = new URLSearchParams(Object.entries(keep).filter(([k]) => !PERIOD_KEYS.has(k)));
  const preset = presetList(presets).match(r, today);
  if (preset === "custom") {
    params.set("from", r.from);
    params.set("to", r.to);
  } else params.set("preset", preset);
  return `${path}?${params.toString()}`;
}

/**
 * The one period control (Transactions and Analysis): previous / label / next, stepping by the range's own unit (a
 * day, a week, a month, three months, a year, or its length in days), and a menu with the presets and Custom range (two
 * dates, GET form). The URL is the only state: `?preset=` or `?from=&to=`, and `?month=YYYY-MM` still works as an
 * alias. Server component; place it in PageHeader `controls`.
 */
export async function PeriodBar({ path, range, today, keep = {}, error, typed, presets = "stats", label, notAfter }: PeriodBarProps) {
  const { locale, t } = await getI18n();
  const set = presetList(presets);
  const active = set.match(range, today);
  const kept = Object.entries(keep).filter(([k]) => !PERIOD_KEYS.has(k));
  const next = shiftRange(range, 1);
  return (
    <PeriodBarClient
      key={`${range.from}~${range.to}~${error ?? ""}`}
      label={label ?? rangeLabel(range.from, range.to, locale)}
      presets={set.list.map((p) => ({
        value: p,
        label: t.period.presets[p],
        href: periodHref(path, set.range(p, today), today, keep, presets),
        active: !error && active === p,
      }))}
      prevHref={periodHref(path, shiftRange(range, -1), today, keep, presets)}
      nextHref={notAfter !== undefined && next.from > notAfter ? null : periodHref(path, next, today, keep, presets)}
      custom={{
        action: path,
        keep: kept,
        from: typed?.from ?? range.from,
        to: typed?.to ?? range.to,
        active: !!error || active === "custom",
        // Analysis steps through single days and weeks too: the form opens only for a range that is none of its periods.
        open: !!error || (active === "custom" && wholeMonths(range) == null && (presets !== "analysis" || periodKindOf(range) === "range")),
        error,
      }}
    />
  );
}
