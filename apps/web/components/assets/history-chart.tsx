import type { NetWorth } from "@yomi/core";
import { moneyText } from "@/components/money";
import { fmt } from "@/i18n";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { dayLabel } from "@/lib/month";
import { allSeries, chartDays, flowMarkers, investPartial, investSeries, missingNames, netCashSeries, netDepositsSeries } from "./chart-series";
import { type ChartLine, SeriesChart } from "./series-chart";

/** "Net worth from Sep 1, 2026 to Sep 30, 2026: $1.00 to $2.00" for the line's first and last known day; null under two days. */
function summaryOf(dates: string[], values: (number | null)[], what: string, currency: string, t: Dictionary, locale: Locale): string | null {
  const known = dates.map((date, i) => ({ date, v: values[i] })).filter((p): p is { date: string; v: number } => p.v != null);
  if (known.length < 2) return null;
  const first = known[0]!;
  const last = known[known.length - 1]!;
  return fmt(t.assets.chartLabel, {
    what,
    from: dayLabel(first.date, locale, { year: true }),
    to: dayLabel(last.date, locale, { year: true }),
    start: moneyText(first.v, currency),
    end: moneyText(last.v, currency),
  });
}

const withValues = (lines: ChartLine[]) => lines.filter((l) => l.values.some((v) => v != null));

interface HistoryProps {
  nw: NetWorth;
  /** The chart currency: the converted one, or the only (or first) currency. */
  currency: string;
  t: Dictionary;
  locale: Locale;
}

/**
 * All: net worth (emphasized; dashed on days an account known later has no value yet) with cash, investments
 * and credit cards, each from its own first known day, switchable from the legend. Server component.
 */
export function AllHistory({ nw, currency, t, locale, what }: HistoryProps & { what: string }) {
  const c = t.assets.chart;
  const days = chartDays(nw, currency);
  const s = allSeries(days);
  const dates = days.map((d) => d.date);
  const summary = summaryOf(dates, s.netWorth, what, currency, t, locale);
  if (!summary) return null;
  const lines = withValues([
    { id: "netWorth", label: c.netWorth, values: s.netWorth, partial: s.partial, style: "primary" },
    { id: "cash", label: c.cash, values: s.cash, style: "secondary" },
    { id: "investments", label: c.investments, values: s.investments, style: "tertiary" },
    { id: "cards", label: c.cards, values: s.cards, style: "card" },
  ]);
  return (
    <div className="flex flex-col gap-1">
      <SeriesChart
        dates={dates}
        lines={lines}
        currency={currency}
        summary={summary}
        caption={fmt(t.assets.chartTableCaption, { what })}
        legend
        missing={missingNames(days)}
        testId="assets-history"
      />
      {s.partial.some(Boolean) && <p className="text-hint text-3">{c.partialNote}</p>}
    </div>
  );
}

/** Cash: cash plus card balances, one line. */
export function CashHistory({ nw, currency, t, locale }: HistoryProps) {
  const days = chartDays(nw, currency);
  const values = netCashSeries(days);
  const dates = days.map((d) => d.date);
  const summary = summaryOf(dates, values, t.assets.netCash, currency, t, locale);
  if (!summary) return null;
  return (
    <SeriesChart
      dates={dates}
      lines={[{ id: "netCash", label: t.assets.netCash, values, style: "primary" }]}
      currency={currency}
      summary={summary}
      caption={fmt(t.assets.chartTableCaption, { what: t.assets.netCash })}
      testId="assets-cash-history"
    />
  );
}

/**
 * Investments: market value with net deposits since the first known day (the gap is market gain or loss) and
 * dots for trades and dividends; or unrealized P/L on days whose values come with positions.
 */
export function InvestHistory({ nw, currency, t, locale, kind }: HistoryProps & { kind: "value" | "pnl" }) {
  const ia = t.assets.investments;
  const c = t.assets.chart;
  const days = chartDays(nw, currency);
  const values = investSeries(days, kind);
  const dates = days.map((d) => d.date);
  const what = kind === "pnl" ? ia.pnl : ia.value;
  const summary = summaryOf(dates, values, what, currency, t, locale);
  if (!summary) return null;
  const partial = investPartial(days, values);
  const lines: ChartLine[] = [{ id: kind, label: what, values, style: "primary", partial }];
  const deposits = kind === "value" ? netDepositsSeries(dates, values, nw.flows, currency, nw.converted != null, partial) : null;
  const since = deposits ? dayLabel(deposits.from, locale, { year: true }) : "";
  if (deposits) lines.push({ id: "deposits", label: fmt(c.deposits, { date: since }), values: deposits.values, style: "deposits" });
  const markers = kind === "value" ? flowMarkers(dates, values, nw.flows) : [];
  return (
    <div className="flex flex-col gap-1">
      <SeriesChart
        dates={dates}
        lines={lines}
        currency={currency}
        summary={summary}
        caption={fmt(t.assets.chartTableCaption, { what })}
        legend={lines.length > 1}
        markers={markers}
        markerLine={kind}
        missing={missingNames(days, "investment")}
        testId="assets-invest-history"
      />
      {partial.some(Boolean) && <p className="text-hint text-3">{t.assets.chart.partialInvestNote}</p>}
      {deposits && (
        <p className="text-hint text-3" data-testid="assets-deposits-hint">
          {fmt(c.depositsHint, { date: since })}
          {markers.length > 0 && ` ${c.markersHint}`}
        </p>
      )}
    </div>
  );
}
