import type { RangeCurrencyOverview } from "@yomi/core";
import { ChartColumnIcon, TagIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Money } from "@/components/money";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt, plural } from "@/i18n";
import { rich } from "@/i18n/rich";
import { getI18n } from "@/i18n/server";
import { CategoryList } from "./category-list";
import { MonthlyTrend } from "./monthly-trend";
import { TargetEditor } from "./target-editor";

export interface CurrencySectionProps {
  data: RangeCurrencyOverview;
  /** Query params naming the period on /transactions: `{ month }` or `{ from, to }`. */
  period: Record<string, string>;
  /** Days the daily average divides by. */
  days: number;
  /** 'YYYY-MM' when the range is exactly one calendar month (the target block shows only then). */
  month: string | null;
  /** Several currencies on the page: label headings with their code. */
  showCode: boolean;
  /** Some currency on this month has the target. */
  anyTarget: boolean;
  /** Analysis Insights for this currency, placed right after the summary card. */
  insights?: ReactNode;
  /** The monthly trend; off for weeks (a month or two of bars says nothing about seven days). */
  showTrend?: boolean;
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
 * One currency over the period, the neutral full numbers: summary card, monthly trend, categories, small payments.
 * Comparisons and the largest rows live in Insights on Analysis.
 */
export async function CurrencySection({ data, period, days, month, showCode, anyTarget, insights, showTrend = true }: CurrencySectionProps) {
  const { t } = await getI18n();
  const cur = data.currency;
  const code = showCode && <span className="ml-2 text-meta font-normal text-3">{cur}</span>;

  return (
    <section aria-label={fmt(t.stats.sectionLabel, { currency: cur })} className="flex flex-col gap-8">
      <div
        className={
          month
            ? "grid gap-6 rounded-xl border border-border bg-surface p-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] sm:gap-8"
            : "rounded-xl border border-border bg-surface p-5"
        }
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-meta text-2">
            {fmt(t.stats.spending, { currency: cur })}
            <span className="text-3">{t.stats.myPart}</span>
          </div>
          <div className="text-hero font-semibold tracking-[-0.02em]">
            <Money minor={data.spendingMinor} currency={cur} />
          </div>
          <div className="flex flex-col gap-y-1 text-body text-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
            <span>
              {rich(t.stats.dailyAvg, { amount: <Money minor={data.dailyAverageMinor} currency={cur} /> })}
              <span className="text-3">{plural(t.stats.days, days)}</span>
            </span>
            <Dot />
            <span>{plural(t.stats.count, data.transactionCount)}</span>
          </div>
          {(data.incomeMinor > 0 || data.sharedReceivableMinor > 0) && (
            <div className="flex flex-col gap-y-1 text-body text-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
              {data.incomeMinor > 0 && (
                <span>
                  {rich(t.stats.income, { amount: <Money minor={data.incomeMinor} currency={cur} sign="inflow" /> })}
                </span>
              )}
              {data.incomeMinor > 0 && data.sharedReceivableMinor > 0 && <Dot />}
              {data.sharedReceivableMinor > 0 && (
                <span>
                  {rich(t.stats.fronted, { amount: <Money minor={data.sharedReceivableMinor} currency={cur} /> })}
                  <Link href="/split" className="ml-0.5 text-primary underline-offset-4 hover:underline">
                    {t.stats.frontedLink}
                  </Link>
                </span>
              )}
            </div>
          )}
        </div>
        {month && (
          <TargetEditor month={month} currency={cur} spendingMinor={data.spendingMinor} target={data.target} otherCurrencyTarget={anyTarget && !data.target} />
        )}
      </div>

      {insights}

      {showTrend && data.monthly && (
        <div className="flex flex-col gap-4">
          <h2 className="flex items-center gap-2 text-title font-semibold">
            <ChartColumnIcon className="size-[18px] text-2" aria-hidden />
            {t.stats.monthly}
            {code}
          </h2>
          <MonthlyTrend points={data.monthly} currency={cur} />
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-3">
        <ListCard icon={TagIcon} title={<>{t.stats.categories}{code}</>}>
          <CategoryList period={period} currency={cur} items={data.byCategory} />
        </ListCard>
        {data.smallPayments.count > 0 && (
          <p className="text-body text-2">
            {rich(plural(t.stats.small, data.smallPayments.count), {
              amount: <Money minor={data.smallPayments.minor} currency={cur} className="text-foreground" />,
            })}
            <span className="text-3">{rich(t.stats.smallEach, { amount: <Money minor={data.smallPayments.thresholdMinor} currency={cur} /> })}</span>
          </p>
        )}
      </div>
    </section>
  );
}
