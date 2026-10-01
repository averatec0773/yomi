import { moneyText } from "@/components/money";
import { fmt } from "@/i18n";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { dayLabel } from "@/lib/month";

const W = 1000;
const H = 150;
const PAD = 8;
/** The screen-reader table lists at most this many days (evenly spaced, last day always). */
const TABLE_ROWS = 40;

/**
 * A calm single-hue line of a daily series (net worth, cash, holdings value or P/L): neutral stroke, a
 * zero line when the series crosses it, first and last day under it. The SVG is a picture with a
 * spoken summary; a visually hidden table carries the numbers. Server component.
 */
export function HistoryChart({
  points,
  currency,
  what,
  t,
  locale,
  testId,
}: {
  points: { date: string; value: number | null }[];
  currency: string;
  /** What the line shows, e.g. "Net worth". */
  what: string;
  t: Dictionary;
  locale: Locale;
  testId?: string;
}) {
  const known = points.filter((p): p is { date: string; value: number } => p.value != null);
  if (known.length < 2) return null;
  const a = t.assets;
  const values = known.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const n = points.length - 1 || 1;
  const x = (i: number) => (i / n) * W;
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  // Days with nothing known break the line instead of drawing zero.
  const segments: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (cur.length) segments.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  });
  if (cur.length) segments.push(cur.join(" "));
  const first = known[0]!;
  const last = known[known.length - 1]!;
  const label = fmt(a.chartLabel, {
    what,
    from: dayLabel(first.date, locale, { year: true }),
    to: dayLabel(last.date, locale, { year: true }),
    start: moneyText(first.value, currency),
    end: moneyText(last.value, currency),
  });
  const step = Math.max(1, Math.ceil(known.length / TABLE_ROWS));
  const rows = known.filter((_, i) => i % step === 0 || i === known.length - 1);

  return (
    <figure className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className="block h-[150px] w-full text-foreground/55">
        {lo < 0 && hi > 0 && <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="stroke-border" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
        <line x1={0} x2={W} y1={H - 1} y2={H - 1} className="stroke-border" vectorEffect="non-scaling-stroke" />
        {segments.map((s, i) => (
          <polyline key={i} points={s} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div aria-hidden className="flex justify-between text-hint text-3">
        <span>{dayLabel(points[0]!.date, locale)}</span>
        <span>{dayLabel(points[points.length - 1]!.date, locale)}</span>
      </div>
      <table className="sr-only">
        <caption>{fmt(a.chartTableCaption, { what })}</caption>
        <thead>
          <tr>
            <th scope="col">{a.chartDate}</th>
            <th scope="col">{a.chartValue}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.date}>
              <th scope="row">{dayLabel(p.date, locale, { year: true })}</th>
              <td>{moneyText(p.value, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
