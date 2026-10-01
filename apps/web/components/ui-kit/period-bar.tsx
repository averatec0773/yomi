import { type DateRange, matchPreset, presetRange, shiftRange, STATS_PRESETS, wholeMonths } from "@yomi/core";
import { getI18n } from "@/i18n/server";
import { rangeLabel } from "@/lib/period";
import { PeriodBarClient } from "./period-bar-client";

export interface PeriodBarProps {
  /** The page the links go to ("/transactions", "/stats"). */
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
}

const PERIOD_KEYS = new Set(["preset", "from", "to", "month"]);

/** `?preset=` when the range is a preset today, else `?from=&to=`, plus the kept params. */
export function periodHref(path: string, r: DateRange, today: string, keep: Record<string, string> = {}): string {
  const params = new URLSearchParams(Object.entries(keep).filter(([k]) => !PERIOD_KEYS.has(k)));
  const preset = matchPreset(r, today);
  if (preset === "custom") {
    params.set("from", r.from);
    params.set("to", r.to);
  } else params.set("preset", preset);
  return `${path}?${params.toString()}`;
}

/**
 * The one period control (Transactions and Stats): previous / label / next, stepping by the range's own unit (a month,
 * three months, a year, or its length in days), and a menu with the presets and Custom range (two dates, GET form).
 * The URL is the only state: `?preset=` or `?from=&to=`, and `?month=YYYY-MM` still works as an alias. Server
 * component; place it in PageHeader `controls`.
 */
export async function PeriodBar({ path, range, today, keep = {}, error, typed }: PeriodBarProps) {
  const { locale, t } = await getI18n();
  const active = matchPreset(range, today);
  const kept = Object.entries(keep).filter(([k]) => !PERIOD_KEYS.has(k));
  return (
    <PeriodBarClient
      key={`${range.from}~${range.to}~${error ?? ""}`}
      label={rangeLabel(range.from, range.to, locale)}
      presets={STATS_PRESETS.map((p) => ({
        value: p,
        label: t.period.presets[p],
        href: periodHref(path, presetRange(p, today), today, keep),
        active: !error && active === p,
      }))}
      prevHref={periodHref(path, shiftRange(range, -1), today, keep)}
      nextHref={periodHref(path, shiftRange(range, 1), today, keep)}
      custom={{
        action: path,
        keep: kept,
        from: typed?.from ?? range.from,
        to: typed?.to ?? range.to,
        active: !!error || active === "custom",
        open: !!error || (active === "custom" && wholeMonths(range) == null),
        error,
      }}
    />
  );
}
