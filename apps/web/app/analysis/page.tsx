import { analysisReport, getCurrentUser, listCategories, netWorthChange, periodKindOf, presetRange } from "@yomi/core";
import { ArrowRightIcon, ChartColumnIcon } from "lucide-react";
import Link from "next/link";
import { DayView } from "@/components/analysis/day-view";
import { EmptyPeriod } from "@/components/analysis/empty-period";
import { CurrencyInsights, type InsightContext, PartialCurrencies, sourceLabel, sourceName } from "@/components/analysis/insights";
import { type SourceLine, SourcesPopover } from "@/components/analysis/sources-popover";
import { CsvLink } from "@/components/csv-link";
import { Money } from "@/components/money";
import { CurrencySection } from "@/components/stats/currency-section";
import { PageHeader } from "@/components/ui-kit/page-header";
import { PeriodBar } from "@/components/ui-kit/period-bar";
import { Segmented } from "@/components/ui-kit/segmented";
import { fmt } from "@/i18n";
import { rich } from "@/i18n/rich";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { dayLabel } from "@/lib/month";
import { resolvePagePeriod } from "@/lib/page-period";
import { previousLabel, rangeLabel } from "@/lib/period";
import { getToday } from "@/lib/settings";
import { distinctSourceNames } from "@/lib/source-names";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t.stats.title} · yomi` };
}

const KIND_PRESET = { day: "yesterday", week: "this_week", month: "this_month", year: "this_year" } as const;

/**
 * Analysis: one place for the numbers of any period. A Day / Week / Month / Year switcher sits next to the PeriodBar
 * (presets and custom ranges). A day stays light (DayView). Any other period keeps the Stats composition: a net worth
 * line (with investments), then per currency the summary card with its Insights, the monthly trend, categories, and
 * the largest rows or top merchants. "Today" is the user's time-zone day.
 */
export default async function AnalysisPage({ searchParams }: PageProps<"/analysis">) {
  const sp = await searchParams;
  const { locale, t } = await getI18n();
  const db = await getDb();
  const user = getCurrentUser();
  const today = await getToday();
  const { range, error, typed } = resolvePagePeriod(sp, today, presetRange("this_month", today), t, "analysis");
  const kind = periodKindOf(range);
  const report = error ? null : await analysisReport(db, user, range, { today });

  const baseLabel = kind === "day" ? dayLabel(range.from, locale, { weekday: true, year: true }) : rangeLabel(range.from, range.to, locale);
  const label = report?.inProgress ? fmt(t.analysis.soFar, { label: baseLabel }) : baseLabel;
  const sourceTotals = report?.sourceTotals ?? [];
  // A source's rows in the period: its spending per currency, else its income, else none ("—").
  const totalsOf = (key: string): SourceLine["totals"] => {
    const mine = sourceTotals.filter((s) => s.key === key);
    const spend = mine.filter((s) => s.count > 0);
    const income = spend.length === 0 ? mine.filter((s) => s.incomeCount > 0) : [];
    return {
      count: spend.reduce((a, s) => a + s.count, 0) + income.reduce((a, s) => a + s.incomeCount, 0),
      amounts: spend.length > 0 ? spend.map((s) => ({ minor: s.spendingMinor, currency: s.currency })) : income.map((s) => ({ minor: s.incomeMinor, currency: s.currency })),
      income: income.length > 0,
    };
  };
  // A bank synced through Plaid and also imported from files gets a name for each.
  const freshness = distinctSourceNames(report?.freshness ?? [], t);
  const listed = new Set(freshness.map((f) => f.key));
  // Rows no listed source covers (added by hand) still add to the page's numbers, so they get a line too.
  const unlisted = [...new Map(sourceTotals.filter((s) => !listed.has(s.key)).map((s) => [s.key, s.source])).entries()].map(
    ([key, source]): SourceLine => ({ key, name: sourceLabel(source, t), detail: null, state: null, reminder: null, totals: totalsOf(key) }),
  );
  const sources: SourceLine[] = freshness.map((f) => ({
    key: f.key,
    name: sourceName(f, t),
    detail:
      f.kind === "capture"
        ? f.lastOn
          ? fmt(t.analysis.sources.lastPasted, { date: dayLabel(f.lastOn, locale) })
          : t.analysis.sources.never
        : f.through
          ? fmt(t.analysis.sources.through, { date: dayLabel(f.through, locale, { year: f.through.slice(0, 4) !== today.slice(0, 4) }) })
          : t.analysis.sources.never,
    state: f.state,
    reminder: f.exportReminder ? fmt(t.analysis.sources.reminder, { source: sourceName(f, t) }) : null,
    totals: f.kind === "investments" ? null : totalsOf(f.key),
  }));
  sources.push(...unlisted);

  const header = (
    <PageHeader
      title={t.stats.title}
      controls={
        <>
          <Segmented
            mode="links"
            label={t.analysis.kinds.label}
            value={kind === "range" ? null : kind}
            options={(["day", "week", "month", "year"] as const).map((k) => ({ value: k, label: t.analysis.kinds[k], href: `/analysis?preset=${KIND_PRESET[k]}` }))}
          />
          <PeriodBar path="/analysis" range={range} today={today} error={error} typed={typed} presets="analysis" label={label} notAfter={today} />
        </>
      }
      actions={
        !error && (
          <>
            <SourcesPopover sources={sources} />
            <CsvLink compact href={`/api/export/transactions.csv?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`} />
          </>
        )
      }
    />
  );

  if (!report) return <div>{header}</div>;

  // Same order as the Transactions spend strip: the currency with the most rows first.
  const ordered = [...report.currencies].sort((a, b) => b.transactionCount - a.transactionCount || b.spendingMinor - a.spendingMinor);
  const attention = report.attention.map((x) => (x.kind === "plaid" ? { ...x, label: freshness.find((f) => f.key === x.key)?.label ?? x.label } : x));
  const ctx: InsightContext = { report: { ...report, currencies: ordered, freshness, attention }, locale, t };

  if (kind === "day") {
    const names = new Map((await listCategories(db, user)).map((c) => [c.id, c.name]));
    return (
      <div>
        {header}
        <DayView ctx={ctx} categoryNames={names} />
      </div>
    );
  }

  // A default target alone puts its currency in the overview; with no rows the period is still empty.
  const hasData = ordered.some((c) => c.transactionCount > 0 || c.incomeMinor > 0);
  const anyTarget = ordered.some((c) => c.target != null);
  const period: Record<string, string> = report.month ? { month: report.month } : { from: range.from, to: range.to };
  // Stocks next to flows: how net worth moved over the same days (only when account balances exist).
  const nwAll = report.future ? null : await netWorthChange(db, user, { from: range.from, to: range.to < today ? range.to : today, currency: "USD" });
  // An empty period leaves out changes that are zero.
  const nwChange =
    nwAll && (hasData || (nwAll.converted ? nwAll.converted.changeMinor !== 0 : nwAll.currencies.some((c) => c.changeMinor !== 0))) ? nwAll : null;
  // The investments part of that change, deposits apart from the market (only with investment accounts).
  const invest = (report.investments ?? []).filter((i) => i.changeMinor != null && (hasData || i.changeMinor !== 0));
  const nwLine = (nwChange || invest.length > 0) && (
    <p className="mb-6 flex flex-wrap items-center gap-x-1.5 text-body text-2" data-testid="stats-net-worth">
      {nwChange && (
        <>
          <span>
            {rich(t.stats.netWorthChange, {
              amount: nwChange.converted ? (
                <Money minor={nwChange.converted.changeMinor} currency={nwChange.converted.currency} sign="signed" className="text-foreground" />
              ) : (
                <>
                  {nwChange.currencies.map((c, i) => (
                    <span key={c.currency}>
                      {i > 0 && " · "}
                      <Money minor={c.changeMinor} currency={c.currency} sign="signed" showCode={nwChange.currencies.length > 1} className="text-foreground" />
                    </span>
                  ))}
                </>
              ),
            })}
          </span>
          <Link href="/assets" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
            <ArrowRightIcon className="size-3.5" aria-hidden />
            {t.stats.netWorthLink}
          </Link>
        </>
      )}
      {invest.length > 0 && (
        <span data-testid="net-worth-investments">
          {nwChange && <span aria-hidden>· </span>}
          {rich(t.analysis.investLine, {
            // One "Investments" label, then each currency's change.
            change: invest.map((i, k) => (
              <span key={i.currency}>
                {k > 0 && " · "}
                <Money minor={i.changeMinor!} currency={i.currency} sign="signed" showCode={invest.length > 1} className="text-foreground" />
                {/* Without deposits the whole change is the market's: no split to show. */}
                {i.netDepositsMinor !== 0 &&
                  rich(i.marketMinor == null ? t.analysis.investDeposits : t.analysis.investSplit, {
                    market: i.marketMinor != null && <Money minor={i.marketMinor} currency={i.currency} sign="signed" />,
                    deposits: <Money minor={i.netDepositsMinor} currency={i.currency} />,
                  })}
              </span>
            )),
          })}
        </span>
      )}
    </p>
  );

  return (
    <div>
      {header}
      {nwLine}
      {/* An empty period says how far the sources reach in its empty state instead. */}
      {hasData && <PartialCurrencies ctx={ctx} className="mb-6 flex flex-col gap-2" />}
      {!hasData ? (
        <EmptyPeriod ctx={ctx} icon={ChartColumnIcon} period={baseLabel} />
      ) : (
        <div className="flex flex-col gap-12">
          {ordered.map((c) => (
            <CurrencySection
              key={c.currency}
              data={c}
              period={period}
              days={report.days}
              inProgress={report.inProgress}
              previousLabel={previousLabel(range.from, range.to, report.lengthDays, t)}
              month={report.month}
              showCode={ordered.length > 1}
              anyTarget={anyTarget}
              multiYear={range.from.slice(0, 4) !== range.to.slice(0, 4)}
              insights={<CurrencyInsights c={c} ctx={ctx} />}
              showTrend={kind !== "week"}
            />
          ))}
        </div>
      )}
    </div>
  );
}
