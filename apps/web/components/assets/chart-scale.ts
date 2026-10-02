// Y axis of the Assets history charts: a padded domain with a minimum visible span, and a few round ticks.
// Pure (minor units in, minor units out), shared by server and client code.
import { formatMinor, minorDigits } from "@yomi/core/money";

/**
 * The smallest span the axis shows, as a share of the largest absolute value: 5%. A day's move of 1% (an
 * ordinary day for a stock portfolio) then fills at most a fifth of the height, and a move under 5% never
 * fills the chart. Without it, $1,001 → $994 (−0.7%) was drawn from the top edge to the bottom edge.
 */
export const MIN_SPAN_RATIO = 0.05;
/** Room above the highest and below the lowest value, as a share of the span. */
export const PAD_RATIO = 0.08;
/** About this many ticks (round steps decide the exact count). */
const TARGET_TICKS = 3;

export interface AxisScale {
  lo: number;
  hi: number;
  /** Round values inside [lo, hi], ascending. */
  ticks: number[];
  /** Distance between ticks, minor units. */
  step: number;
}

/** 1, 2, 2.5 or 5 × 10^k, the first at or above `raw`. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/**
 * Domain and ticks for values in minor units of `currency`. The span is at least MIN_SPAN_RATIO of the
 * largest absolute value (and at least 10 major units), centred on the data, padded by PAD_RATIO, and never
 * pushed across zero when every value is on one side of it. Ticks are round steps of at least one major unit.
 * Null without values.
 */
export function axisScale(values: readonly number[], currency: string): AxisScale | null {
  if (values.length === 0) return null;
  const unit = 10 ** minorDigits(currency);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const minSpan = Math.max(Math.max(Math.abs(min), Math.abs(max)) * MIN_SPAN_RATIO, 10 * unit);
  let lo = min;
  let hi = max;
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const pad = (hi - lo) * PAD_RATIO;
  lo -= pad;
  hi += pad;
  if (min >= 0 && lo < 0) {
    hi -= lo;
    lo = 0;
  } else if (max <= 0 && hi > 0) {
    lo -= hi;
    hi = 0;
  }
  const ticksFor = (step: number) => {
    const out: number[] = [];
    for (let k = Math.ceil(lo / step); k * step <= hi; k++) out.push(k * step);
    return out;
  };
  // A round step can leave a single tick inside the domain; then use a finer one, so a scale always shows two.
  let step = Math.max(niceStep((hi - lo) / TARGET_TICKS), unit);
  let ticks = ticksFor(step);
  if (ticks.length < 2 && step > unit) {
    step = Math.max(niceStep((hi - lo) / (2 * TARGET_TICKS)), unit);
    ticks = ticksFor(step);
  }
  return { lo, hi, ticks, step };
}

/** Vertical position of `v` in a domain, 0 (top) to 1 (bottom). */
export function yFraction(v: number, scale: Pick<AxisScale, "lo" | "hi">): number {
  return 1 - (v - scale.lo) / (scale.hi - scale.lo);
}

/**
 * Short label of a tick: whole units without cents ("$1,000"), cents only when the step is below one unit,
 * thousands and millions as K and M from 100,000 units ("$120K", "$1.25M"). Negatives use "−".
 */
export function tickLabel(minor: number, currency: string, step: number): string {
  const unit = 10 ** minorDigits(currency);
  const abs = Math.abs(minor);
  const sign = minor < 0 ? "−" : "";
  const major = abs / unit;
  if (major >= 100_000) {
    const [div, suffix] = major >= 1_000_000 ? [1_000_000, "M"] : [1_000, "K"];
    const symbol = formatMinor(0, currency).replace(/[\d.,]+$/, "");
    const n = Number((major / div).toPrecision(4));
    return `${sign}${symbol}${n}${suffix}`;
  }
  const text = formatMinor(abs, currency);
  return sign + (step % unit === 0 ? text.replace(/\.\d+$/, "") : text);
}
