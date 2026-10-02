import "server-only";
import { analysisPresetRange, type DateRange, isAnalysisPreset, isStatsPreset, LedgerError, monthRangeOf, presetRange, resolvePeriod } from "@yomi/core";
import type { Dictionary } from "@/i18n";
import { errorText } from "@/i18n/errors";
import { isMonth } from "./month";

type Params = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export interface PagePeriod {
  range: DateRange;
  /** The URL named a period explicitly (preset, range or month). */
  explicit: boolean;
  /** A custom range that could not be used; `range` is then the fallback. */
  error: string | null;
  /** The from/to typed by the user, for refilling the form after an error. */
  typed?: { from: string; to: string };
}

/**
 * The period a page shows, from its search params: `?preset=`, `?from=&to=` (validated by core: real dates, from ≤ to,
 * at most 5 years), or `?month=YYYY-MM` (alias for that month); otherwise `fallback`. Analysis also takes its day and
 * week presets (`presets: "analysis"`).
 */
export function resolvePagePeriod(sp: Params, today: string, fallback: DateRange, t: Dictionary, presets: "stats" | "analysis" = "stats"): PagePeriod {
  const preset = first(sp.preset);
  const from = first(sp.from);
  const to = first(sp.to);
  if (from !== undefined || to !== undefined) {
    try {
      return { range: resolvePeriod({ preset: "custom", from: from ?? "", to: to ?? "" }, today), explicit: true, error: null };
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      return { range: fallback, explicit: false, error: from && to ? errorText(e, t) : t.period.needBothDates, typed: { from: from ?? "", to: to ?? "" } };
    }
  }
  if (isStatsPreset(preset)) return { range: presetRange(preset, today), explicit: true, error: null };
  if (presets === "analysis" && isAnalysisPreset(preset)) return { range: analysisPresetRange(preset, today), explicit: true, error: null };
  const month = first(sp.month);
  if (isMonth(month)) return { range: monthRangeOf(month), explicit: true, error: null };
  return { range: fallback, explicit: false, error: null };
}

/** Search params other than the period ones, as plain strings (for links that keep filters). */
export function otherParams(sp: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const value = first(v);
    if (value !== undefined && !["preset", "from", "to", "month"].includes(k)) out[k] = value;
  }
  return out;
}
