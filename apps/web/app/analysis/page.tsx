import { analysisReport, getCurrentUser, getTimeZone, listCategories, netWorthChange, periodKindOf, presetRange, todayIn } from "@yomi/core";
import { ArrowRightIcon, ChartColumnIcon } from "lucide-react";
import Link from "next/link";
import { DayView } from "@/components/analysis/day-view";
import { type InsightContext, PeriodInsights, sourceName } from "@/components/analysis/insights";
import { type SourceLine, SourcesPopover } from "@/components/analysis/sources-popover";
import { CsvLink } from "@/components/csv-link";
import { Money } from "@/components/money";
import { CurrencySection } from "@/components/stats/currency-section";
import { EmptyState } from "@/components/ui-kit/empty-state";
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

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t.stats.title} · yomi` };
}

const KIND_PRESET = { day: "yesterday", week: "this_week", month: "this_month", year: "this_year" } as const;

/**
 * Analysis: one place for the numbers of any period. A Day / Week / Month / Year switcher sits next to the PeriodBar
 * (presets and custom ranges). Fixed periods get Insights on top (comparisons, shifts, unusual and largest rows, new
 * merchants, target, investments, data freshness); a day stays light; weeks, months, years and custom ranges keep the
 * neutral full numbers below. "Today" is the user's time-zone day.
 */
export default async function AnalysisPage({ searchParams }: PageProps<"/analysis">) {
  const sp = await searchParams;
  const { locale, t } = await getI18n();
  const db = await getDb();
  const user = getCurrentUser();
  const today = todayIn(await getTimeZone(db, user));
  const { range, error, typed } = resolvePagePeriod(sp, today, presetRange("this_month", today), t, "analysis");
  const kind = periodKindOf(range);
  const report = error ? null : await analysisReport(db, user, range, { today });

  const baseLabel = kind === "day" ? dayLabel(range.from, locale, { weekday: true, year: true }) : rangeLabel(range.from, range.to, locale);
  const label = report?.inProgress ? fmt(t.analysis.soFar, { label: baseLabel }) : baseLabel;
  const sources: SourceLine[] = (report?.freshness ?? []).map((f) => ({
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
  }));

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
  const ctx: InsightContext = {
    report: { ...report, currencies: ordered },
    locale,
    t,
    previousLabel: previousLabel(range.from, range.to, report.lengthDays, t),
    showCode: ordered.length > 1,
  };

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
  const nwChange = report.future ? null : await netWorthChange(db, user, { from: range.from, to: range.to < today ? range.to : today, currency: "USD" });
  const nwLine = nwChange && (
    <p className="mb-6 flex flex-wrap items-center gap-x-1.5 text-body text-2" data-testid="stats-net-worth">
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
    </p>
  );

  return (
    <div>
      {header}
      {kind !== "range" && hasData && <PeriodInsights ctx={ctx} />}
      {nwLine}
      {!hasData ? (
        <EmptyState
          icon={ChartColumnIcon}
          action={
            <Link href="/import" className="text-primary underline-offset-4 hover:underline">
              {t.transactions.goImport}
            </Link>
          }
        >
          {report.future ? t.analysis.empty.future : fmt(t.stats.noData, { period: rangeLabel(range.from, range.to, locale) })}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-12">
          {ordered.map((c) => (
            <CurrencySection key={c.currency} data={c} period={period} days={report.days} month={report.month} showCode={ordered.length > 1} anyTarget={anyTarget} />
          ))}
        </div>
      )}
    </div>
  );
}
