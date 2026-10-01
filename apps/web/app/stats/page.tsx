import { getCurrentUser, netWorthChange, presetRange, rangeOverview } from "@yomi/core";
import { ArrowRightIcon, ChartColumnIcon } from "lucide-react";
import Link from "next/link";
import { CsvLink } from "@/components/csv-link";
import { Money } from "@/components/money";
import { CurrencySection } from "@/components/stats/currency-section";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { PageHeader } from "@/components/ui-kit/page-header";
import { PeriodBar } from "@/components/ui-kit/period-bar";
import { fmt } from "@/i18n";
import { rich } from "@/i18n/rich";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { todayLocal } from "@/lib/month";
import { resolvePagePeriod } from "@/lib/page-period";
import { previousLabel, rangeLabel } from "@/lib/period";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t.stats.title} · yomi` };
}

export default async function StatsPage({ searchParams }: PageProps<"/stats">) {
  const sp = await searchParams;
  const { locale, t } = await getI18n();
  const today = todayLocal();
  const { range, error, typed } = resolvePagePeriod(sp, today, presetRange("this_month", today), t);

  const header = (
    <PageHeader
      title={t.stats.title}
      controls={<PeriodBar path="/stats" range={range} today={today} error={error} typed={typed} />}
      actions={
        !error && <CsvLink compact href={`/api/export/transactions.csv?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`} />
      }
    />
  );

  if (error) return <div>{header}</div>;

  const db = await getDb();
  const overview = await rangeOverview(db, getCurrentUser(), range, { today });
  // Same order as the Transactions spend strip: the currency with the most rows first.
  const currencies = [...overview.currencies].sort((a, b) => b.transactionCount - a.transactionCount || b.spendingMinor - a.spendingMinor);
  const multi = currencies.length > 1;
  // A default target alone puts its currency in the overview; with no rows the period is still empty.
  const hasData = currencies.some((c) => c.transactionCount > 0 || c.incomeMinor > 0);
  const anyTarget = currencies.some((c) => c.target != null);
  const period: Record<string, string> = overview.month ? { month: overview.month } : { from: range.from, to: range.to };
  const label = previousLabel(range.from, range.to, overview.lengthDays, t);
  const multiYear = range.from.slice(0, 4) !== range.to.slice(0, 4);
  // Stocks next to flows: how net worth moved over the same days (only when account balances exist).
  const nwChange = await netWorthChange(db, getCurrentUser(), { from: range.from, to: range.to < today ? range.to : today, currency: "USD" });
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
          {fmt(t.stats.noData, { period: rangeLabel(range.from, range.to, locale) })}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-12">
          {currencies.map((c) => (
            <CurrencySection
              key={c.currency}
              data={c}
              period={period}
              days={overview.days}
              inProgress={overview.inProgress}
              previousLabel={label}
              month={overview.month}
              showCode={multi}
              anyTarget={anyTarget}
              multiYear={multiYear}
            />
          ))}
        </div>
      )}
    </div>
  );
}
