"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { moneyText } from "@/components/money";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { dayLabel } from "@/lib/month";
import { cn } from "@/lib/utils";
import { axisScale, tickLabel, yFraction } from "./chart-scale";
import type { FlowMarker } from "./chart-series";

/** How a line is drawn. Neutral greys by weight; clay only for card balances owed (style.md, Assets). */
export type LineStyle = "primary" | "secondary" | "tertiary" | "card" | "deposits";

export interface ChartLine {
  id: string;
  label: string;
  values: (number | null)[];
  style: LineStyle;
  /** Days whose segment to the next day is drawn dashed (net worth with an account still unknown). */
  partial?: boolean[];
}

const W = 1000;
/** The screen-reader table lists at most this many days (evenly spaced, last day always). */
const TABLE_ROWS = 40;
/** The tooltip names at most this many missing accounts, then "and N more". */
const MISSING_NAMES = 3;

const STROKE: Record<LineStyle, { className: string; width: number; dash?: string }> = {
  primary: { className: "text-foreground", width: 2.25 },
  secondary: { className: "text-foreground/55", width: 1.5 },
  tertiary: { className: "text-foreground/30", width: 1.5 },
  card: { className: "text-neg", width: 1.5 },
  deposits: { className: "text-foreground/45", width: 1.5, dash: "2 4" },
};
const PARTIAL_DASH = "5 4";

function Swatch({ style }: { style: LineStyle }) {
  const s = STROKE[style];
  return (
    <svg viewBox="0 0 16 4" className={cn("h-1 w-4 shrink-0", s.className)} aria-hidden>
      <line x1={0} x2={16} y1={2} y2={2} stroke="currentColor" strokeWidth={Math.max(s.width, 2)} strokeDasharray={s.dash} />
    </svg>
  );
}

/**
 * A daily history chart for Assets: one or more lines on a shared, labelled y axis (see chart-scale.ts),
 * first and last day under it. Hover (or arrow keys on the focused plot) shows every visible line's value
 * for that day, which accounts a partial day lacks, and the trades and dividends of that day. With `legend`,
 * chips switch lines on and off (local state; at least one stays on) and the axis fits what is shown. Unknown
 * days break a line instead of drawing zero. The SVG is a picture with a spoken summary; a visually hidden table
 * carries the numbers.
 */
export function SeriesChart({
  dates,
  lines,
  currency,
  summary,
  caption,
  legend = false,
  missing,
  markers,
  markerLine,
  height = 168,
  testId,
}: {
  dates: string[];
  lines: ChartLine[];
  currency: string;
  /** Spoken summary of the picture. */
  summary: string;
  /** Caption of the hidden table. */
  caption: string;
  legend?: boolean;
  /** Per day, the accounts a partial day lacks. */
  missing?: string[][];
  markers?: FlowMarker[];
  /** The line the markers sit on. */
  markerLine?: string;
  height?: number;
  testId?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const c = t.assets.chart;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  const shown = lines.filter((l) => !hidden.has(l.id));
  const scale = axisScale(
    shown.flatMap((l) => l.values.filter((v): v is number => v != null)),
    currency,
  );
  const n = Math.max(dates.length - 1, 1);
  const xPct = (i: number) => (dates.length === 1 ? 50 : (i / n) * 100);
  const yPct = (v: number) => (scale ? yFraction(v, scale) * 100 : 50);
  const x = (i: number) => (xPct(i) / 100) * W;
  const y = (v: number) => (yPct(v) / 100) * height;

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (lines.length - next.size > 1) next.add(id);
      return next;
    });

  const indexAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(dates.length - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * n)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : dates.length - 1);
    } else if (step) {
      e.preventDefault();
      setHover((h) => Math.min(dates.length - 1, Math.max(0, (h ?? dates.length - 1) + step)));
    } else if (e.key === "Escape") setHover(null);
  };

  const markerAt = new Map((markers ?? []).map((m) => [m.index, m]));
  const markerValues = lines.find((l) => l.id === markerLine && !hidden.has(l.id))?.values;
  const hoverMissing = hover != null ? (missing?.[hover] ?? []) : [];
  const partialHover = hover != null && shown.some((l) => l.partial?.[hover] && l.values[hover] != null);

  const multiYear = dates.length > 0 && dates[0]!.slice(0, 4) !== dates[dates.length - 1]!.slice(0, 4);
  const step = Math.max(1, Math.ceil(dates.length / TABLE_ROWS));
  const rows = dates.map((d, i) => i).filter((i) => (i % step === 0 || i === dates.length - 1) && shown.some((l) => l.values[i] != null));

  return (
    <figure className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      {legend && lines.length > 1 && (
        <div role="group" aria-label={c.legend} className="flex flex-wrap gap-1.5" data-testid="chart-legend">
          {lines.map((l) => {
            const on = !hidden.has(l.id);
            return (
              <button
                key={l.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(l.id)}
                className={cn(
                  "hit relative inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-meta transition-colors duration-[120ms] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  on ? "border-border bg-surface text-foreground" : "border-transparent bg-sunken text-3 line-through decoration-1",
                )}
              >
                <Swatch style={l.style} />
                {l.label}
              </button>
            );
          })}
        </div>
      )}
      <div
        className="relative mt-4 touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ height }}
        tabIndex={0}
        aria-label={summary}
        role="img"
        onPointerMove={(e) => setHover(indexAt(e))}
        onPointerDown={(e) => setHover(indexAt(e))}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden className="absolute inset-0 block size-full overflow-visible">
          {scale?.ticks.map((v) => (
            <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} className={v === 0 ? "stroke-line-strong" : "stroke-line-soft"} vectorEffect="non-scaling-stroke" />
          ))}
          <line x1={0} x2={W} y1={height - 0.5} y2={height - 0.5} className="stroke-border" vectorEffect="non-scaling-stroke" />
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} className="stroke-line-strong" vectorEffect="non-scaling-stroke" />}
          {[...shown].reverse().map((l) => (
            <Line key={l.id} line={l} x={x} y={y} />
          ))}
        </svg>
        {scale?.ticks.map((v) => (
          <span
            key={v}
            aria-hidden
            className="num pointer-events-none absolute left-0 -translate-y-full rounded-sm bg-surface/80 pr-1 text-left text-hint text-3"
            style={{ top: `${yPct(v)}%` }}
          >
            {tickLabel(v, currency, scale.step)}
          </span>
        ))}
        {markerValues &&
          [...markerAt.values()].map((m) => {
            const v = markerValues[m.index];
            if (v == null) return null;
            const dividend = m.items.every((it) => it.type === "dividend");
            return (
              <span
                key={m.index}
                aria-hidden
                data-testid="chart-marker"
                className={cn(
                  "pointer-events-none absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border",
                  dividend ? "border-pos bg-pos" : "border-foreground/70 bg-surface",
                )}
                style={{ left: `${xPct(m.index)}%`, top: `${yPct(v)}%` }}
              />
            );
          })}
        {hover != null &&
          shown.map((l) => {
            const v = l.values[hover];
            return v == null ? null : (
              <span
                key={l.id}
                aria-hidden
                className={cn("pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-surface", STROKE[l.style].className)}
                style={{ left: `${xPct(hover)}%`, top: `${yPct(v)}%` }}
              />
            );
          })}
        {hover != null && (
          <div
            aria-hidden
            data-testid="chart-tooltip"
            className={cn(
              "pointer-events-none absolute top-0 z-10 flex w-max max-w-64 flex-col gap-1 rounded-lg border border-border bg-raised px-3 py-2 text-meta shadow-dialog",
              xPct(hover) > 50 ? "-translate-x-[calc(100%+12px)]" : "translate-x-3",
            )}
            style={{ left: `${xPct(hover)}%` }}
          >
            <span className="text-2">{dayLabel(dates[hover]!, locale, { year: true, weekday: true })}</span>
            {shown.map((l) =>
              l.values[hover] == null ? null : (
                <span key={l.id} className="flex items-center gap-2">
                  <Swatch style={l.style} />
                  <span className="flex-1 text-2">{l.label}</span>
                  <span className="num font-medium text-foreground">{amountText(l.values[hover]!, currency)}</span>
                </span>
              ),
            )}
            {partialHover && hoverMissing.length > 0 && (
              <span className="text-2">
                {fmt(c.partial, {
                  names:
                    hoverMissing.length > MISSING_NAMES
                      ? fmt(c.more, { names: hoverMissing.slice(0, MISSING_NAMES).join(", "), count: hoverMissing.length - MISSING_NAMES })
                      : hoverMissing.join(", "),
                })}
              </span>
            )}
            {markerValues &&
              markerAt.get(hover)?.items.map((it, k) => (
                <span key={k} className="flex items-center gap-2 border-t border-line-soft pt-1">
                  <span className="flex-1 text-2">
                    {t.assets.investments.types[it.type] ?? it.type} {it.symbol ?? ""}
                  </span>
                  <span className={cn("num", it.amountMinor > 0 && "text-pos")}>{signedText(it.amountMinor, it.currency)}</span>
                </span>
              ))}
          </div>
        )}
      </div>
      <div aria-hidden className="flex justify-between text-hint text-3">
        <span>{dates[0] ? dayLabel(dates[0], locale, { year: multiYear }) : ""}</span>
        <span>{dates.length ? dayLabel(dates[dates.length - 1]!, locale, { year: multiYear }) : ""}</span>
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t.assets.chartDate}</th>
            {shown.map((l) => (
              <th key={l.id} scope="col">
                {l.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={dates[i]}>
              <th scope="row">
                {dayLabel(dates[i]!, locale, { year: true })}
                {shown.some((l) => l.partial?.[i]) ? ` (${c.partialShort})` : ""}
              </th>
              {shown.map((l) => (
                <td key={l.id}>{l.values[i] == null ? t.common.none : amountText(l.values[i]!, currency)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** "$1.00" / "−$1.00" (a true minus, like Money). */
function amountText(minor: number, currency: string): string {
  return minor < 0 ? `−${moneyText(-minor, currency)}` : moneyText(minor, currency);
}

/** "+$1.00" / "−$1.00". */
function signedText(minor: number, currency: string): string {
  return minor > 0 ? `+${moneyText(minor, currency)}` : amountText(minor, currency);
}

/** One line: runs of known days as polylines, dashed where the day is partial. */
function Line({ line, x, y }: { line: ChartLine; x: (i: number) => number; y: (v: number) => number }) {
  const s = STROKE[line.style];
  const runs: { points: string; dashed: boolean }[] = [];
  let cur: string[] = [];
  let dashed = false;
  const flush = () => {
    if (cur.length) runs.push({ points: cur.join(" "), dashed });
    cur = [];
  };
  line.values.forEach((v, i) => {
    if (v == null) {
      flush();
      return;
    }
    const p = `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    const d = Boolean(line.partial?.[i]);
    if (cur.length && d !== dashed) {
      // The segment into this day keeps the previous style; this day starts the next run.
      cur.push(p);
      flush();
    }
    dashed = d;
    cur.push(p);
  });
  flush();
  return (
    <g className={s.className}>
      {runs.map((r, k) =>
        r.points.includes(" ") ? (
          <polyline
            key={k}
            points={r.points}
            fill="none"
            stroke="currentColor"
            strokeWidth={s.width}
            strokeDasharray={r.dashed ? PARTIAL_DASH : s.dash}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
    </g>
  );
}
