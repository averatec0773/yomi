import { CalendarDaysIcon, ChartCandlestickIcon, FileInputIcon, HourglassIcon, InboxIcon, ListIcon, ReceiptTextIcon } from "lucide-react";
import Link from "next/link";
import { categoryIcon } from "@/components/category-icon";
import { Money } from "@/components/money";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt, plural } from "@/i18n";
import type { Dictionary } from "@/i18n/en";
import { rich } from "@/i18n/rich";
import { dayLabel } from "@/lib/month";
import { AttentionCard, currencyInsightRows, type InsightContext, InsightRow, PartialLine } from "./insights";

const link = "text-primary underline-offset-4 hover:underline";

function sourceLabel(source: string, t: Dictionary): string {
  return t.transactions.sources[source as keyof Dictionary["transactions"]["sources"]] ?? source;
}

/**
 * One day, kept light: per currency what was spent (vs a typical day), the day's rows and anything unusual; then what
 * arrived that day, the market close and anything that needs attention.
 */
export function DayView({ ctx, categoryNames }: { ctx: InsightContext; categoryNames: Map<number, string> }) {
  const { report, t, locale } = ctx;
  const a = t.analysis;
  const day = report.from;
  const dayText = dayLabel(day, locale, { weekday: true });
  const extra = Object.keys(report.partial).filter((cur) => !report.currencies.some((c) => c.currency === cur));
  // The newest day any investment source reaches: a weekday after it has no close yet.
  const investThrough = report.freshness.filter((f) => f.kind === "investments" && f.through).map((f) => f.through!).sort().at(-1) ?? null;

  return (
    <div className="flex max-w-list flex-col gap-6" data-testid="day-view">
      {report.currencies.length === 0 && (
        <EmptyState
          icon={CalendarDaysIcon}
          action={
            <Link href="/import" className={link}>
              {t.transactions.goImport}
            </Link>
          }
        >
          {report.future ? a.empty.future : fmt(a.empty.day, { date: dayText })}
        </EmptyState>
      )}
      {extra.map((cur) => (
        <p key={cur} className="flex items-start gap-2 text-meta text-2" data-testid="insight-partial">
          <HourglassIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {cur}: <PartialLine keys={report.partial[cur]!} ctx={ctx} />
          </span>
        </p>
      ))}

      {report.currencies.map((c) => {
        const cur = c.currency;
        const insights = currencyInsightRows(c, ctx, { comparePrevious: false });
        const rows = c.dayRows ?? [];
        const more = c.transactionCount - rows.length;
        return (
          <section
            key={cur}
            aria-label={fmt(t.stats.sectionLabel, { currency: cur })}
            className="min-w-0 overflow-clip rounded-xl border border-border bg-surface"
            data-testid={`day-${cur}`}
          >
            <div className="flex flex-col gap-1 p-5">
              <div className="text-meta text-2">{fmt(report.inProgress ? a.spentSoFar : a.spentOn, { currency: cur, date: dayText })}</div>
              <div className="text-hero font-semibold tracking-[-0.02em]">
                <Money minor={c.spendingMinor} currency={cur} />
              </div>
              <div className="text-meta text-2">{plural(t.stats.count, c.transactionCount)}</div>
            </div>
            {insights.length > 0 && (
              <ul className="divide-y divide-line-soft border-t border-line-soft" aria-label={fmt(a.insightsFor, { currency: cur })} data-testid="insights">
                {insights}
              </ul>
            )}
            <div className="border-t border-line-soft" data-testid="day-rows">
              <h2 className="flex items-center gap-2 px-4 pt-3 pb-1 text-meta font-medium text-2 md:px-5">
                <ReceiptTextIcon aria-hidden className="size-3.5" />
                {a.dayRows}
              </h2>
              {rows.length === 0 ? (
                <p className="px-4 pb-4 text-body text-2 md:px-5">{t.stats.noSpending}</p>
              ) : (
                <ol className="divide-y divide-line-soft">
                  {rows.map((r) => {
                    const Icon = categoryIcon(r.categoryId == null ? null : (categoryNames.get(r.categoryId) ?? null));
                    return (
                      <li key={r.id} className="flex h-12 items-center gap-3 px-4 md:px-5">
                        <Icon aria-hidden className="size-4 shrink-0 text-2" />
                        <span className="min-w-0 flex-1 truncate">{r.merchant}</span>
                        <span className="hidden shrink-0 text-meta text-3 sm:inline">{sourceLabel(r.source, t)}</span>
                        <Money minor={r.minor} currency={cur} />
                      </li>
                    );
                  })}
                </ol>
              )}
              {more > 0 && (
                <div className="border-t border-line-soft px-4 py-3 md:px-5">
                  <Link href={`/transactions?${new URLSearchParams({ from: day, to: day }).toString()}`} className={`text-meta ${link}`}>
                    {plural(a.seeAll, c.transactionCount)}
                  </Link>
                </div>
              )}
            </div>
          </section>
        );
      })}

      {report.arrivals && (
        <ListCard icon={FileInputIcon} title={a.arrived} data-testid="day-arrived">
          <ul className="divide-y divide-line-soft">
            {report.arrivals.length === 0 ? (
              <InsightRow icon={InboxIcon}>
                <span className="text-2">{a.arrivedNone}</span>
              </InsightRow>
            ) : (
              report.arrivals.map((x) => (
                <InsightRow key={x.source} icon={ListIcon}>
                  {fmt(a.arrivedLine, { count: x.count, source: sourceLabel(x.source, t) })}
                </InsightRow>
              ))
            )}
          </ul>
        </ListCard>
      )}

      {report.investments && report.close && (
        <ListCard icon={ChartCandlestickIcon} title={a.investments} data-testid="day-close">
          <ul className="divide-y divide-line-soft">
            {report.close.marketDay && investThrough != null && investThrough < day ? (
              <InsightRow icon={ChartCandlestickIcon}>
                {fmt(a.close.pending, { date: dayLabel(day, locale), through: dayLabel(investThrough, locale) })}
              </InsightRow>
            ) : report.close.marketDay ? (
              report.investments.map((i) => (
                <InsightRow key={i.currency} icon={ChartCandlestickIcon}>
                  {i.changeMinor == null
                    ? rich(a.investNoStart, { end: <Money minor={i.endMinor ?? 0} currency={i.currency} /> })
                    : rich(a.close.day, {
                        date: dayLabel(day, locale),
                        previous: dayLabel(report.close!.previousClose, locale),
                        change: <Money minor={i.marketMinor ?? i.changeMinor} currency={i.currency} sign="signed" />,
                      })}
                  {i.netDepositsMinor !== 0 && rich(a.close.deposits, { amount: <Money minor={i.netDepositsMinor} currency={i.currency} /> })}
                </InsightRow>
              ))
            ) : (
              <InsightRow icon={ChartCandlestickIcon}>
                {fmt(a.close.noClose, { date: dayLabel(day, locale), previous: dayLabel(report.close.previousClose, locale) })}
              </InsightRow>
            )}
          </ul>
        </ListCard>
      )}

      <AttentionCard ctx={ctx} />
    </div>
  );
}
