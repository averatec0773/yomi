import type { AccountOverview, PositionView } from "@yomi/core";
import { shortDateTime } from "@/components/import/labels";
import { Money } from "@/components/money";
import { fmt } from "@/i18n";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { dayLabel } from "@/lib/month";
import { cn } from "@/lib/utils";
import { pnlTone, weightText } from "./numbers";

const th = "h-row-compact px-2 text-meta font-normal text-2 whitespace-nowrap";
const td = "h-row-compact px-2 whitespace-nowrap";

/**
 * One investment account on /assets: name, provider, snapshot date and last sync, then a dense
 * positions table (cash rows labelled as cash) with a total row per currency, each labelled with the
 * close it is as of. Server component.
 */
export function AccountHoldings({ account, t, locale }: { account: AccountOverview; t: Dictionary; locale: Locale }) {
  const a = t.assets;
  const totals = new Map(account.totals.map((x) => [x.currency, x.marketValueMinor]));
  const multi = account.totals.length > 1;
  const headingId = `account-${account.id}`;
  // IBKR snapshots are the statement of a trading day's close; Plaid's are dated by the day pulled.
  const asOfLabel = account.asOf
    ? fmt(account.provider === "ibkr" ? a.asOfClose : a.asOf, { date: dayLabel(account.asOf, locale) })
    : null;
  const rows = [...account.positions].sort(
    (x, y) => Number(x.securityId == null) - Number(y.securityId == null) || x.currency.localeCompare(y.currency) || y.marketValueMinor - x.marketValueMinor,
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface" data-testid="assets-account">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-soft px-4 py-3 md:px-5">
        <h3 id={headingId} className="text-body font-medium">
          {account.name}
        </h3>
        <span className="rounded-sm border border-border px-1.5 text-meta text-2">{a.providers[account.provider] ?? account.provider}</span>
        {account.asOf && <span className="text-meta text-2">{fmt(a.asOf, { date: dayLabel(account.asOf, locale, { year: true }) })}</span>}
        <span className="text-meta text-2">{account.syncedAt ? fmt(a.lastSynced, { time: shortDateTime(account.syncedAt, locale) }) : a.neverSynced}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-body text-2 md:px-5">{a.noSnapshot}</p>
      ) : (
        <div className="overflow-x-auto px-2 md:px-3">
          <table className="w-full min-w-[600px] border-collapse text-body" aria-label={fmt(a.positions, { name: account.name })}>
            <thead>
              <tr className="border-b border-line-soft text-left">
                <th scope="col" className={th}>
                  {a.cols.symbol}
                </th>
                <th scope="col" className={cn(th, "hidden sm:table-cell")}>
                  {a.cols.name}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {a.cols.quantity}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {a.cols.price}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {a.cols.marketValue}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {a.cols.cost}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {a.cols.pnl}
                </th>
                <th scope="col" className={cn(th, "text-right")} title={a.weightHint}>
                  {a.cols.weight}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <PositionRow key={p.positionKey} p={p} total={totals.get(p.currency) ?? 0} showCode={multi} t={t} />
              ))}
            </tbody>
            <tfoot>
              {account.totals.map((x) => (
                <tr key={x.currency} className="font-medium">
                  <th scope="row" className={cn(td, "text-left font-medium")}>
                    {multi ? `${a.total} ${x.currency}` : a.total}
                    {asOfLabel && (
                      <span className="ml-2 text-meta font-normal text-2" data-testid="assets-account-asof">
                        {asOfLabel}
                      </span>
                    )}
                  </th>
                  <td className={cn(td, "hidden sm:table-cell")} />
                  <td className={td} />
                  <td className={td} />
                  <td className={cn(td, "text-right")}>
                    <Money minor={x.marketValueMinor} currency={x.currency} showCode={multi} />
                  </td>
                  <td className={cn(td, "text-right")}>
                    <Money minor={x.costBasisMinor} currency={x.currency} />
                  </td>
                  <td className={cn(td, "text-right")}>
                    <Money minor={x.unrealizedPnlMinor} currency={x.currency} sign="signed" tone={pnlTone(x.unrealizedPnlMinor)} />
                  </td>
                  <td className={td} />
                </tr>
              ))}
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function PositionRow({ p, total, showCode, t }: { p: PositionView; total: number; showCode: boolean; t: Dictionary }) {
  const a = t.assets;
  const cash = p.securityId == null;
  const none = <span className="text-3">{t.common.none}</span>;
  return (
    <tr className="border-b border-line-soft" data-testid="assets-position" data-position={p.positionKey}>
      <td className={td}>{cash ? <span className="text-2">{a.cash}</span> : <span className="font-medium">{p.symbol ?? t.common.none}</span>}</td>
      <td className={cn(td, "hidden max-w-[16rem] truncate text-2 sm:table-cell")} title={p.name ?? undefined}>
        {cash ? fmt(a.cashName, { currency: p.currency }) : (p.name ?? "")}
      </td>
      <td className={cn(td, "num")}>{cash ? none : p.quantity}</td>
      <td className={cn(td, "num")}>{cash ? none : p.price}</td>
      <td className={cn(td, "text-right")}>
        <Money minor={p.marketValueMinor} currency={p.currency} showCode={showCode} />
      </td>
      <td className={cn(td, "text-right")}>{p.costBasisMinor == null ? none : <Money minor={p.costBasisMinor} currency={p.currency} />}</td>
      <td className={cn(td, "text-right")}>
        {p.unrealizedPnlMinor == null ? none : <Money minor={p.unrealizedPnlMinor} currency={p.currency} sign="signed" tone={pnlTone(p.unrealizedPnlMinor)} />}
      </td>
      <td className={cn(td, "num text-2")}>{weightText(p.marketValueMinor, total)}</td>
    </tr>
  );
}
