import type { MonthlyPoint } from "@yomi/core";
import { Money, moneyText } from "@/components/money";
import { fmt } from "@/i18n";
import { getI18n } from "@/i18n/server";
import { shortMonth } from "@/lib/period";
import { cn } from "@/lib/utils";

const BAR_AREA = "h-24";
/** Above this many months the per-bar values move into the hover label. */
const VALUE_LIMIT = 6;
/** Above this many months only the first month and each January are labelled. */
const LABEL_LIMIT = 12;

/**
 * Spending per calendar month as calm vertical bars (one hue, no gradient). Values sit above the bars
 * for up to six months, otherwise they show on hover; a visually hidden table carries the numbers for
 * screen readers. Months the range only partly covers (or that are not over) use a lighter fill.
 */
export async function MonthlyTrend({ points, currency }: { points: MonthlyPoint[]; currency: string }) {
  const { locale, t } = await getI18n();
  const max = Math.max(...points.map((p) => p.spendingMinor), 1);
  const showValues = points.length <= VALUE_LIMIT;
  const multiYear = points[0]?.month.slice(0, 4) !== points.at(-1)?.month.slice(0, 4);
  const anyPartial = points.some((p) => p.partial);

  return (
    <figure className="flex flex-col gap-2">
      <div className="flex items-end" aria-hidden>
        {points.map((p, i) => {
          const h = p.spendingMinor > 0 ? Math.max((p.spendingMinor / max) * 100, 2) : 0;
          const labelled = points.length <= LABEL_LIMIT || i === 0 || p.month.endsWith("-01");
          const label = shortMonth(p.month, locale, multiYear && (i === 0 || p.month.endsWith("-01")));
          return (
            <div
              key={p.month}
              title={`${shortMonth(p.month, locale, true)} ${moneyText(p.spendingMinor, currency)}${p.partial ? t.stats.trend.partial : ""}`}
              className="group relative flex min-w-0 flex-1 flex-col items-center gap-1"
            >
              {showValues ? (
                <span className="num w-full truncate text-center text-meta text-2">
                  <Money minor={p.spendingMinor} currency={currency} />
                </span>
              ) : (
                <span className="num pointer-events-none absolute -top-5 z-10 hidden rounded-sm bg-surface px-1 text-meta whitespace-nowrap ring-1 ring-border group-hover:block">
                  <Money minor={p.spendingMinor} currency={currency} />
                </span>
              )}
              <div className={cn("flex w-full items-end justify-center border-b border-border px-px transition-colors duration-[120ms] group-hover:bg-sunken", BAR_AREA)}>
                <div
                  className={cn("w-full max-w-10 rounded-t-sm", p.partial ? "bg-foreground/15" : "bg-foreground/30")}
                  style={{ height: `${h}%` }}
                />
              </div>
              <span className={cn("h-4 w-full truncate text-center text-meta text-2", !labelled && "invisible")}>{label}</span>
            </div>
          );
        })}
      </div>
      {anyPartial && <figcaption className="text-meta text-3">{t.stats.trend.partialCaption}</figcaption>}
      <table className="sr-only">
        <caption>{fmt(t.stats.trend.tableCaption, { currency })}</caption>
        <thead>
          <tr>
            <th scope="col">{t.stats.trend.month}</th>
            <th scope="col">{t.stats.trend.spending}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.month}>
              <th scope="row">
                {shortMonth(p.month, locale, true)}
                {p.partial ? t.stats.trend.partial : ""}
              </th>
              <td>{moneyText(p.spendingMinor, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
