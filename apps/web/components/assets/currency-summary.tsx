import type { CurrencyTotals } from "@yomi/core";
import { Money } from "@/components/money";
import { fmt } from "@/i18n";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { dayLabel } from "@/lib/month";
import { pnlTone } from "./numbers";

/**
 * One currency's holdings on /assets: market value with the close it is as of, then cost basis, unrealized P/L and the change
 * since the previous snapshot as signed numbers (gains in moss, losses plain). StatCard look. Server component.
 */
export function CurrencySummary({
  totals,
  previousAsOf,
  asOf,
  showCode,
  t,
  locale,
}: {
  totals: CurrencyTotals;
  previousAsOf: string | null;
  /** Latest snapshot day behind this currency; `close` when every account in it is dated by a trading-day close (IBKR). */
  asOf: { date: string; close: boolean } | null;
  showCode: boolean;
  t: Dictionary;
  locale: Locale;
}) {
  const a = t.assets;
  const c = totals.currency;
  return (
    <section
      aria-label={fmt(a.summaryLabel, { currency: c })}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5"
      data-testid="assets-summary"
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-meta text-2">
          <span>{fmt(a.marketValue, { currency: c })}</span>
          {asOf && <span data-testid="assets-summary-asof">{fmt(asOf.close ? a.asOfClose : a.asOf, { date: dayLabel(asOf.date, locale) })}</span>}
        </div>
        <div className="text-total font-medium">
          <Money minor={totals.marketValueMinor} currency={c} showCode={showCode} />
        </div>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
        <dt className="text-2">{a.costBasis}</dt>
        <dd>
          <Money minor={totals.costBasisMinor} currency={c} />
        </dd>
        <dt className="text-2">{a.unrealized}</dt>
        <dd>
          <Money minor={totals.unrealizedPnlMinor} currency={c} sign="signed" tone={pnlTone(totals.unrealizedPnlMinor)} />
        </dd>
        {totals.changeMinor != null && previousAsOf ? (
          <>
            <dt className="text-2">{fmt(a.change, { date: dayLabel(previousAsOf, locale) })}</dt>
            <dd>
              <Money minor={totals.changeMinor} currency={c} sign="signed" tone={pnlTone(totals.changeMinor)} />
            </dd>
          </>
        ) : (
          <dd className="col-span-2 text-meta text-2">{a.noPrevious}</dd>
        )}
      </dl>
    </section>
  );
}
