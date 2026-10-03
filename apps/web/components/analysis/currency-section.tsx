import type { AnalysisCurrency, RangeCurrencyOverview } from "@yomi/core";
import { ChartColumnIcon, TagIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ProvisionalLabel, ProvisionalNote } from "@/components/capture/provisional";
import { Money } from "@/components/money";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt, plural } from "@/i18n";
import type { Dictionary } from "@/i18n/en";
import { rich } from "@/i18n/rich";
import { getI18n } from "@/i18n/server";
import { dayLabel } from "@/lib/month";
import { CategoryList } from "./category-list";
import { LargestCard } from "./largest-card";
import { MonthlyTrend } from "./monthly-trend";
import { TargetEditor } from "./target-editor";

export interface CurrencySectionProps {
  data: AnalysisCurrency;
  /** Query params naming the period on /transactions: `{ month }` or `{ from, to }`. */
  period: Record<string, string>;
  /** Days the daily average divides by. */
  days: number;
  /** The range contains today: compare daily averages instead of totals. */
  inProgress: boolean;
  /** How the previous period reads: "last month", "the previous 3 months", "last year", "the previous 10 days". */
  previousLabel: string;
  /** 'YYYY-MM' when the range is exactly one calendar month (the target block shows only then). */
  month: string | null;
  /** Several currencies on the page: label headings with their code. */
  showCode: boolean;
  /** Some currency on this month has the target. */
  anyTarget: boolean;
  /** The range crosses a year boundary: dates carry the year. */
  multiYear: boolean;
  /** Short observations under a divider in the summary card (Analysis Insights). */
  insights: ReactNode;
  /** The monthly trend; off for weeks (a month or two of bars says nothing about seven days). */
  showTrend: boolean;
}

/** Neutral comparison with the previous period: totals once the range is over, daily averages while it runs. */
function Comparison({ data, inProgress, label, t }: { data: RangeCurrencyOverview; inProgress: boolean; label: string; t: Dictionary }) {
  const prev = data.previous;
  if (!prev) return null;
  const [current, previous] = inProgress ? [data.dailyAverageMinor, prev.dailyAverageMinor] : [data.spendingMinor, prev.spendingMinor];
  const diff = current - previous;
  const c = t.analysis.compare;
  if (diff === 0) return <span>{fmt(inProgress ? c.dailySame : c.same, { prev: label })}</span>;
  const template = diff < 0 ? (inProgress ? c.dailyLess : c.less) : inProgress ? c.dailyMore : c.more;
  return <span>{rich(template, { prev: label, amount: <Money minor={Math.abs(diff)} currency={data.currency} /> })}</span>;
}

/** Separator between facts; phones put one fact per line instead. */
function Dot() {
  return (
    <span className="hidden text-2 sm:inline" aria-hidden>
      ·
    </span>
  );
}

/**
 * One currency over the period: summary card (with Insights), monthly trend, categories, small payments, and the
 * largest rows or the top merchants. The comparison waits while the currency's data is partial.
 */
export async function CurrencySection({ data, period, days, inProgress, previousLabel, month, showCode, anyTarget, multiYear, insights, showTrend }: CurrencySectionProps) {
  const { locale, t } = await getI18n();
  const cur = data.currency;
  const compare = data.previous != null && data.partialSources.length === 0;
  const code = showCode && <span className="ml-2 text-meta font-normal text-3">{cur}</span>;

  return (
    <section aria-label={fmt(t.analysis.sectionLabel, { currency: cur })} className="flex flex-col gap-8">
      <div
        className={
          month
            ? "grid gap-6 rounded-xl border border-border bg-surface p-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] sm:gap-8"
            : "rounded-xl border border-border bg-surface p-5"
        }
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-meta text-2">
            {fmt(t.analysis.spending, { currency: cur })}
            <span className="text-3">{t.analysis.myPart}</span>
          </div>
          <div className="text-hero font-semibold tracking-[-0.02em]">
            <Money minor={data.spendingMinor} currency={cur} />
          </div>
          <ProvisionalNote totals={data} currency={cur} />
          <div className="flex flex-col gap-y-1 text-body text-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
            {compare && <Comparison data={data} inProgress={inProgress} label={previousLabel} t={t} />}
            {compare && <Dot />}
            <span>
              {rich(t.analysis.dailyAvg, { amount: <Money minor={data.dailyAverageMinor} currency={cur} /> })}
              <span className="text-3">{plural(t.analysis.days, days)}</span>
            </span>
            <Dot />
            <span>{plural(t.analysis.count, data.transactionCount)}</span>
          </div>
          {(data.incomeMinor > 0 || data.sharedReceivableMinor > 0) && (
            <div className="flex flex-col gap-y-1 text-body text-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
              {data.incomeMinor > 0 && (
                <span>
                  {rich(t.analysis.income, { amount: <Money minor={data.incomeMinor} currency={cur} sign="inflow" /> })}
                </span>
              )}
              {data.incomeMinor > 0 && data.sharedReceivableMinor > 0 && <Dot />}
              {data.sharedReceivableMinor > 0 && (
                <span>
                  {rich(t.analysis.fronted, { amount: <Money minor={data.sharedReceivableMinor} currency={cur} /> })}
                  <Link href="/split" className="ml-0.5 text-primary underline-offset-4 hover:underline">
                    {t.analysis.frontedLink}
                  </Link>
                </span>
              )}
            </div>
          )}
          {insights}
        </div>
        {month && (
          <TargetEditor month={month} currency={cur} spendingMinor={data.spendingMinor} target={data.target} otherCurrencyTarget={anyTarget && !data.target} />
        )}
      </div>

      {showTrend && data.monthly && (
        <div className="flex flex-col gap-4">
          <h2 className="flex items-center gap-2 text-title font-semibold">
            <ChartColumnIcon className="size-[18px] text-2" aria-hidden />
            {t.analysis.monthly}
            {code}
          </h2>
          <MonthlyTrend points={data.monthly} currency={cur} />
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <ListCard icon={TagIcon} title={<>{t.analysis.categories}{code}</>}>
            <CategoryList period={period} currency={cur} items={data.byCategory} />
          </ListCard>
          {data.smallPayments.count > 0 && (
            <p className="text-body text-2">
              {rich(plural(t.analysis.small, data.smallPayments.count), {
                amount: <Money minor={data.smallPayments.minor} currency={cur} className="text-foreground" />,
              })}
              <span className="text-3">{rich(t.analysis.smallEach, { amount: <Money minor={data.smallPayments.thresholdMinor} currency={cur} /> })}</span>
            </p>
          )}
        </div>

        <LargestCard
          code={code}
          largest={
            data.largest.length === 0 ? (
              <p className="px-4 py-4 text-body text-2 md:px-5">{t.analysis.noSpending}</p>
            ) : (
              <ol className="divide-y divide-line-soft">
                {data.largest.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/transactions?month=${r.occurredOn.slice(0, 7)}`}
                      className="flex h-12 items-center gap-3 px-4 transition-colors duration-[120ms] hover:bg-sunken md:px-5"
                    >
                      <span className={multiYear ? "w-24 shrink-0 text-meta text-2" : "w-16 shrink-0 text-meta text-2"}>
                        {dayLabel(r.occurredOn, locale, { year: multiYear })}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{r.merchant}</span>
                      {r.provisional && <ProvisionalLabel kind="capture" />}
                      <Money minor={r.minor} currency={cur} />
                    </Link>
                  </li>
                ))}
              </ol>
            )
          }
          merchants={
            data.topMerchants.length === 0 ? (
              <p className="px-4 py-4 text-body text-2 md:px-5">{t.analysis.noSpending}</p>
            ) : (
              <ol className="divide-y divide-line-soft">
                {data.topMerchants.map((m) => (
                  <li key={m.merchant}>
                    <Link
                      href={`/transactions?${new URLSearchParams({ ...period, q: m.merchant }).toString()}`}
                      className="flex h-12 items-center gap-3 px-4 transition-colors duration-[120ms] hover:bg-sunken md:px-5"
                    >
                      <span className="min-w-0 flex-1 truncate">{m.merchant}</span>
                      <span className="num shrink-0 text-meta text-3">{plural(t.analysis.categoryCount, m.count)}</span>
                      <span className="num w-10 shrink-0 text-right text-meta text-2">{m.share > 0 && m.share < 100 ? "<1%" : `${Math.round(m.share / 100)}%`}</span>
                      <Money minor={m.minor} currency={cur} />
                    </Link>
                  </li>
                ))}
              </ol>
            )
          }
        />
      </div>
    </section>
  );
}
