import type { BankConnectionView } from "@yomi/contracts";
import {
  addDays,
  type AccountOverview,
  type ConvertedTotals,
  convertMinor,
  type FxTable,
  type InvestmentActivity,
  type NetWorth,
  type PortfolioOverview,
} from "@yomi/core";
import { ArrowRightIcon, ChartCandlestickIcon, ChartLineIcon, ChartPieIcon, CoinsIcon, LandmarkIcon, PlugIcon, ReceiptTextIcon } from "lucide-react";
import Link from "next/link";
import { formatMinor as fmtMoney } from "@yomi/core/money";
import { ResumePendingExchange } from "@/components/bank/connect-bank-button";
import { BankConnections } from "@/components/bank/bank-connections";
import { ConnectBrokerage } from "@/components/bank/connect-brokerage";
import { shortDateTime } from "@/components/import/labels";
import { Money } from "@/components/money";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { ListCard } from "@/components/ui-kit/list-card";
import { Segmented } from "@/components/ui-kit/segmented";
import { StatCard } from "@/components/ui-kit/stat-card";
import { fmt, plural } from "@/i18n";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { errorText } from "@/i18n/errors";
import { rich } from "@/i18n/rich";
import { dayLabel } from "@/lib/month";
import { AccountHoldings } from "./account-holdings";
import { AccountRow } from "./account-row";
import { CurrencySummary } from "./currency-summary";
import { HistoryChart } from "./history-chart";
import { pnlTone, weightText } from "./numbers";
import {
  type AssetsParams,
  assetsHref,
  cashFlowText,
  CurrencySwitch,
  oneCurrency,
  RangeChips,
  RateLine,
  seriesOf,
  startingBalanceAccounts,
} from "./shared";
import { StartingBalance } from "./starting-balance";

export interface AssetsViewProps {
  params: AssetsParams;
  nw: NetWorth;
  o: PortfolioOverview;
  /** Holdings converted with the same FX table as the net worth; null without FX. */
  holdingsConverted: ConvertedTotals | null;
  fx: FxTable | null;
  cashFlow: { currency: string; minor: number }[] | null;
  statsHref: string;
  activity: InvestmentActivity[];
  brokerages: BankConnectionView[];
  plaid: { configured: boolean; defaultEnvironment: "sandbox" | "production"; environments: ("sandbox" | "production")[] };
  ibkr: { configured: boolean; missing: string[] };
  today: string;
  t: Dictionary;
  locale: Locale;
}

const fxErrorText = (nw: NetWorth, t: Dictionary) => (nw.fxError ? errorText(nw.fxError, t) : null);

// ---------- All ----------

export function AllView(p: AssetsViewProps) {
  const { nw, o, t, locale, params } = p;
  const a = t.assets;
  if (!nw.hasBalances && o.totals.length === 0) {
    return (
      <EmptyState icon={LandmarkIcon} action={<StartingBalance accounts={startingBalanceAccounts(nw.accounts)} today={p.today} variant="button" />}>
        {a.emptyAll}
      </EmptyState>
    );
  }
  const one = oneCurrency(nw);
  const tracked = nw.accounts.filter((x) => x.balances.length > 0).sort((x, y) => Number(x.class === "card") - Number(y.class === "card"));
  const untracked = nw.accounts.filter((x) => x.balances.length === 0 && !x.plaidLinked);
  const cashTotals = nw.currencies.filter((c) => c.cashMinor !== 0 || c.cardsMinor !== 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <StatCard
          className="gap-3 lg:col-span-2"
          aria-label={a.netWorth}
          label={
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-body">{a.netWorth}</span>
              <CurrencySwitch params={params} t={t} />
            </span>
          }
          value={
            one ? (
              <span data-testid="assets-net-worth">
                <Money minor={one.parts.totalMinor} currency={one.currency} />
              </span>
            ) : (
              <span className="flex flex-wrap gap-x-5 text-total" data-testid="assets-net-worth">
                {nw.currencies.map((c) => (
                  <Money key={c.currency} minor={c.totalMinor} currency={c.currency} showCode />
                ))}
              </span>
            )
          }
          meta={nw.converted ? <RateLine nw={nw} t={t} locale={locale} /> : nw.currencies.length > 1 ? <span>{fxErrorText(nw, t) ?? a.perCurrencyOnly}</span> : null}
        >
          {one && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-body text-2" data-testid="assets-breakdown">
              <span>{rich(a.parts.cash, { amount: <Money minor={one.parts.cashMinor} currency={one.currency} /> })}</span>
              <span>{rich(a.parts.holdings, { amount: <Money minor={one.parts.holdingsMinor} currency={one.currency} /> })}</span>
              {one.parts.cardsMinor !== 0 && (
                <span className="text-neg">{rich(a.parts.cards, { amount: <Money minor={one.parts.cardsMinor} currency={one.currency} tone="neg" /> })}</span>
              )}
              {one.changeMinor != null && (
                <span className="md:ml-auto">
                  {rich(a.change30, { amount: <Money minor={one.changeMinor} currency={one.currency} sign="signed" tone={pnlTone(one.changeMinor)} className="text-foreground" /> })}
                </span>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <RangeChips params={params} t={t} />
            <span className="text-hint text-3">{a.dailySnapshots}</span>
          </div>
          <HistoryChart
            points={seriesOf(nw, one?.currency ?? nw.currencies[0]?.currency ?? "USD", (x) => x.totalMinor)}
            currency={one?.currency ?? nw.currencies[0]?.currency ?? "USD"}
            what={one ? a.netWorth : `${a.netWorth} · ${nw.currencies[0]?.currency ?? ""}`}
            t={t}
            locale={locale}
            testId="assets-history"
          />
          <CashFlowLink {...p} />
        </StatCard>

        <StatCard
          label={a.byCurrency}
          aria-label={a.byCurrency}
          value={
            <dl className="flex flex-col tracking-normal" data-testid="assets-by-currency">
              {nw.currencies.map((c) => (
                <div key={c.currency} className="flex items-baseline gap-3 border-b border-line-soft py-2.5 last:border-b-0">
                  <dt className="w-12 text-body font-medium">{c.currency}</dt>
                  <dd className="flex-1 text-right text-title font-semibold">
                    <Money minor={c.totalMinor} currency={c.currency} />
                  </dd>
                </div>
              ))}
            </dl>
          }
          meta={<span className="text-hint text-3">{a.neverSummed}</span>}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ListCard
          title={a.cashAndCards}
          icon={LandmarkIcon}
          aside={cashTotals.map((c) => plainSigned(c.cashMinor + c.cardsMinor, c.currency)).join(" · ")}
          data-testid="assets-cash-card"
        >
          {tracked.map((x) => (
            <AccountRow key={x.id} account={x} t={t} locale={locale} />
          ))}
          {untracked.length > 0 && <p className="px-4 py-2.5 text-meta text-2 md:px-5">{plural(a.notTracked, untracked.length)}</p>}
          <StartingBalance accounts={startingBalanceAccounts(nw.accounts)} today={p.today} defaultAccountId={untracked[0]?.id} />
        </ListCard>
        <HoldingsCard {...p} />
      </div>
    </div>
  );
}

function CashFlowLink({ cashFlow, statsHref, t }: AssetsViewProps) {
  return (
    <Link href={statsHref} className="inline-flex w-fit items-center gap-1.5 text-body text-primary underline-offset-4 hover:underline" data-testid="assets-cash-flow">
      <span>{cashFlowText(cashFlow, t)}</span>
      <ArrowRightIcon className="size-3.5" aria-hidden />
    </Link>
  );
}

/** Holdings summary for All: per brokerage account, its top positions; a connect row when no Plaid brokerage exists. */
function HoldingsCard({ o, holdingsConverted, params, brokerages, plaid, t, locale }: AssetsViewProps) {
  const a = t.assets;
  const aside = holdingsConverted
    ? `${fmtMoney(holdingsConverted.marketValueMinor, holdingsConverted.currency)} · ${fmt(a.unrealizedAside, { amount: signed(holdingsConverted.unrealizedPnlMinor, holdingsConverted.currency) })}`
    : o.totals.map((x) => fmtMoney(x.marketValueMinor, x.currency)).join(" · ");
  const withData = o.accounts.filter((x) => x.asOf);
  return (
    <ListCard title={a.holdings} icon={ChartCandlestickIcon} aside={aside || undefined} data-testid="assets-holdings-card">
      {withData.length === 0 && <EmptyState variant="inline" icon={ChartCandlestickIcon}>{a.empty}</EmptyState>}
      {withData.map((acct) => (
        <HoldingsGroup key={acct.id} account={acct} t={t} locale={locale} />
      ))}
      {brokerages.length === 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-sunken/50 px-4 py-3 text-meta text-2 md:px-5">
          <span className="flex-1 font-medium">{fmt(a.viaPlaid, { name: a.anyBrokerage })}</span>
          <span>{a.notConnected}</span>
          {plaid.configured && (
            <Link href={`${assetsHref(params, { view: "investments" })}#sources`} className="text-primary underline-offset-4 hover:underline">
              {a.connect}
            </Link>
          )}
        </div>
      )}
      <Link
        href={assetsHref(params, { view: "investments" })}
        className="flex h-12 items-center gap-2 px-4 text-body text-primary underline-offset-4 hover:underline md:px-5"
      >
        <ArrowRightIcon className="size-4" aria-hidden />
        {a.moreHoldings}
      </Link>
    </ListCard>
  );
}

/** "+$1.00" / "−$1.00" / "$0.00" for quiet header notes. */
function signed(minor: number, currency: string): string {
  return minor > 0 ? `+${fmtMoney(minor, currency)}` : plainSigned(minor, currency);
}

/** "−$1.00" for negatives, plain otherwise. */
function plainSigned(minor: number, currency: string): string {
  return minor < 0 ? `−${fmtMoney(-minor, currency)}` : fmtMoney(minor, currency);
}

function HoldingsGroup({ account, t, locale }: { account: AccountOverview; t: Dictionary; locale: Locale }) {
  const a = t.assets;
  const positions = account.positions.filter((x) => x.securityId != null).sort((x, y) => y.marketValueMinor - x.marketValueMinor);
  const cash = account.positions.filter((x) => x.securityId == null);
  const asOf = account.asOf ? fmt(account.provider === "ibkr" ? a.asOfClose : a.asOf, { date: dayLabel(account.asOf, locale) }) : "";
  return (
    <div data-testid="assets-holdings-group">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 bg-sunken/50 px-4 py-2.5 text-meta text-2 md:px-5">
        <span className="flex-1 font-medium">
          {account.name} · {asOf}
        </span>
        <span className="num text-left">
          {plural(a.positionsCount, positions.length)}
          {cash.map((c) => ` · ${fmt(a.brokerageCash, { amount: fmtMoney(c.marketValueMinor, c.currency) })}`).join("")}
        </span>
      </div>
      {positions.slice(0, 5).map((x) => (
        <div key={x.positionKey} className="flex h-[52px] items-center gap-3 px-4 md:px-5" data-testid="assets-holding-row">
          <span className="w-16 shrink-0 truncate text-body font-medium">{x.symbol ?? t.common.none}</span>
          <span className="num hidden w-24 shrink-0 text-left text-meta text-2 sm:inline">{x.quantity}</span>
          <span className="num hidden w-20 shrink-0 text-meta text-2 sm:inline">{x.price}</span>
          <span className="flex-1 text-right text-body font-medium">
            <Money minor={x.marketValueMinor} currency={x.currency} />
          </span>
          <span className="w-24 shrink-0 text-right text-meta">
            {x.unrealizedPnlMinor == null ? (
              <span className="text-3">{t.common.none}</span>
            ) : (
              <Money minor={x.unrealizedPnlMinor} currency={x.currency} sign="signed" tone={pnlTone(x.unrealizedPnlMinor)} />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------- Cash ----------

export function CashView(p: AssetsViewProps) {
  const { nw, t, locale, params } = p;
  const a = t.assets;
  const back = addDays(nw.asOf, -30);
  const then = nw.series.find((x) => x.date === back);
  const cashCurrencies = nw.currencies.filter((c) => c.cashMinor !== 0 || c.cardsMinor !== 0);
  const one = oneCurrency(nw);
  const accounts = [...nw.accounts].sort(
    (x, y) => Number(x.balances.length === 0) - Number(y.balances.length === 0) || Number(x.class === "card") - Number(y.class === "card"),
  );
  const eligible = startingBalanceAccounts(nw.accounts);

  return (
    <div className="flex flex-col gap-4">
      {cashCurrencies.length === 0 ? (
        <EmptyState icon={CoinsIcon} action={<StartingBalance accounts={eligible} today={p.today} variant="button" />}>
          {a.emptyAll}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="assets-cash-hero">
          {cashCurrencies.map((c) => {
            const prev = then?.byCurrency[c.currency];
            const change = prev ? c.cashMinor + c.cardsMinor - (prev.cashMinor + prev.cardsMinor) : null;
            return (
              <StatCard
                key={c.currency}
                aria-label={fmt(a.cashHero, { currency: c.currency })}
                label={fmt(a.cashHero, { currency: c.currency })}
                value={<Money minor={c.cashMinor} currency={c.currency} />}
                meta={
                  <>
                    {c.cardsMinor !== 0 && <span className="text-neg">{rich(a.cardsLine, { amount: <Money minor={c.cardsMinor} currency={c.currency} tone="neg" /> })}</span>}
                    {change != null && <span>{rich(a.change30, { amount: <Money minor={change} currency={c.currency} sign="signed" tone={pnlTone(change)} /> })}</span>}
                  </>
                }
              />
            );
          })}
        </div>
      )}

      {one && (
        <ListCard title={a.cashHistory} icon={ChartLineIcon} action={<RangeChips params={params} t={t} />} data-testid="assets-cash-history-card">
          <div className="flex flex-col gap-3 px-4 py-4 md:px-5">
            {nw.converted && (
              <p className="text-meta text-2">
                <RateLine nw={nw} t={t} locale={locale} />
              </p>
            )}
            <HistoryChart
              points={seriesOf(nw, one.currency, (x) => x.cashMinor + x.cardsMinor)}
              currency={one.currency}
              what={a.netCash}
              t={t}
              locale={locale}
              testId="assets-cash-history"
            />
            <CashFlowLink {...p} />
          </div>
        </ListCard>
      )}
      {!one && <CashFlowLink {...p} />}

      <ListCard title={a.accountsTitle} icon={LandmarkIcon} count={accounts.length} data-testid="assets-accounts">
        {accounts.map((x) => (
          <AccountRow
            key={x.id}
            account={x}
            t={t}
            locale={locale}
            action={
              x.balances.length === 0 && !x.plaidLinked ? (
                <StartingBalance accounts={eligible} today={p.today} defaultAccountId={x.id} variant="button" label={a.setStarting} />
              ) : undefined
            }
          />
        ))}
        <StartingBalance accounts={eligible} today={p.today} />
      </ListCard>
    </div>
  );
}

// ---------- Investments ----------

export function InvestmentsView(p: AssetsViewProps) {
  const { nw, o, holdingsConverted: hc, fx, t, locale, params, activity } = p;
  const a = t.assets;
  const ia = a.investments;
  const one = oneCurrency(nw);
  const multi = o.totals.length > 1;
  return (
    <div className="flex flex-col gap-6">
      {o.totals.length === 0 ? (
        <EmptyState icon={ChartCandlestickIcon}>{a.empty}</EmptyState>
      ) : hc || !multi ? (
        <StatCard
          className="gap-3"
          aria-label={ia.marketValue}
          label={
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-body">{ia.marketValue}</span>
              <CurrencySwitch params={params} t={t} />
            </span>
          }
          value={
            <span data-testid="assets-market-value">
              {hc ? <Money minor={hc.marketValueMinor} currency={hc.currency} /> : <Money minor={o.totals[0]!.marketValueMinor} currency={o.totals[0]!.currency} />}
            </span>
          }
          meta={nw.converted ? <RateLine nw={nw} t={t} locale={locale} /> : null}
        >
          <InvestNumbers cost={hc?.costBasisMinor ?? o.totals[0]!.costBasisMinor} pnl={hc?.unrealizedPnlMinor ?? o.totals[0]!.unrealizedPnlMinor} currency={hc?.currency ?? o.totals[0]!.currency} t={t} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              mode="links"
              label={ia.chart.label}
              value={params.chart}
              options={(["value", "pnl"] as const).map((c) => ({ value: c, label: ia.chart[c], href: assetsHref(params, { chart: c }) }))}
            />
            <RangeChips params={params} t={t} />
          </div>
          {one && (
            <HistoryChart
              points={seriesOf(nw, one.currency, (x) => (x.holdingsMinor === 0 ? null : params.chart === "pnl" ? x.pnlMinor : x.holdingsMinor))}
              currency={one.currency}
              what={params.chart === "pnl" ? ia.pnl : ia.value}
              t={t}
              locale={locale}
              testId="assets-invest-history"
            />
          )}
          <p className="text-meta text-2">{a.lastCloseNote}</p>
        </StatCard>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {o.totals.map((x) => (
              <CurrencySummary key={x.currency} totals={x} previousAsOf={null} asOf={null} showCode t={t} locale={locale} />
            ))}
          </div>
          {nw.fxError && <p className="text-meta text-2">{errorText(nw.fxError, t)}</p>}
        </div>
      )}

      {o.accounts.map((acct) => (
        <AccountHoldings key={acct.id} account={acct} t={t} locale={locale} />
      ))}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Allocation o={o} fx={fx} target={hc?.currency ?? null} t={t} />
        <ListCard title={ia.recent} icon={ReceiptTextIcon} data-testid="assets-activity">
          {activity.length === 0 ? (
            <EmptyState variant="inline" icon={ReceiptTextIcon}>
              {ia.noRecent}
            </EmptyState>
          ) : (
            activity.map((x) => (
              <div key={x.id} className="flex min-h-12 items-center gap-3 px-4 py-2 md:px-5" data-testid="assets-activity-row">
                <span className="w-16 shrink-0 text-meta text-2">{dayLabel(x.date, locale)}</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-medium">
                    {ia.types[x.type] ?? x.type} {x.symbol ?? ""}
                  </span>
                  <span className="truncate text-meta text-2">
                    {x.accountName}
                    {x.quantity ? ` · ${x.quantity}` : ""}
                  </span>
                </div>
                <span className="text-body">
                  <Money minor={x.amountMinor} currency={x.currency} sign="inflow" />
                </span>
              </div>
            ))
          )}
        </ListCard>
      </div>

      <Sources {...p} />
    </div>
  );
}

function InvestNumbers({ cost, pnl, currency, t }: { cost: number; pnl: number; currency: string; t: Dictionary }) {
  const ia = t.assets.investments;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-body text-2" data-testid="assets-invest-numbers">
      <span>{rich(ia.cost, { amount: <Money minor={cost} currency={currency} /> })}</span>
      <span>{rich(ia.unrealized, { amount: <Money minor={pnl} currency={currency} sign="signed" tone={pnlTone(pnl)} /> })}</span>
    </div>
  );
}

/** Market value by symbol (all accounts), one neutral hue; converted when a rate is known, else per currency. */
function Allocation({ o, fx, target, t }: { o: PortfolioOverview; fx: FxTable | null; target: string | null; t: Dictionary }) {
  const ia = t.assets.investments;
  const groups = new Map<string, Map<string, number>>();
  for (const acct of o.accounts) {
    for (const x of acct.positions) {
      const currency = target && fx ? target : x.currency;
      const value = target && fx ? convertMinor(x.marketValueMinor, x.currency, target, fx) : x.marketValueMinor;
      const key = x.securityId == null ? t.assets.cash : (x.symbol ?? t.common.none);
      const g = groups.get(currency) ?? new Map<string, number>();
      g.set(key, (g.get(key) ?? 0) + value);
      groups.set(currency, g);
    }
  }
  return (
    <ListCard title={ia.allocation} icon={ChartPieIcon} data-testid="assets-allocation">
      {groups.size === 0 && <EmptyState variant="inline" icon={ChartPieIcon}>{t.assets.empty}</EmptyState>}
      {[...groups].map(([currency, g]) => {
        const rows = [...g].sort((x, y) => y[1] - x[1]);
        const total = rows.reduce((n, [, v]) => n + Math.max(v, 0), 0);
        return (
          <div key={currency} className="flex flex-col gap-2 px-4 py-3 md:px-5">
            <span className="text-meta text-2">{fmt(ia.allocationHint, { currency })}</span>
            <ul className="flex flex-col gap-1.5">
              {rows.map(([symbol, v]) => {
                const pct = total > 0 ? Math.max(0, (v / total) * 100) : 0;
                return (
                  <li key={symbol} className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-3 text-meta" data-testid="assets-allocation-row">
                    <span className="truncate font-medium text-foreground">{symbol}</span>
                    <span className="h-2 overflow-hidden rounded-sm bg-sunken" aria-hidden>
                      <span className="block h-full rounded-sm bg-foreground/30" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="num text-2">{weightText(v, total)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </ListCard>
  );
}

/** IBKR setup and Plaid brokerages (connect, list), as on the old Assets page. */
function Sources({ ibkr, plaid, brokerages, o, t, locale }: AssetsViewProps) {
  const a = t.assets;
  const ibkrSyncedAt = o.accounts
    .filter((x) => x.provider === "ibkr" && x.syncedAt)
    .map((x) => x.syncedAt!)
    .sort()
    .at(-1);
  return (
    <section id="sources" className="flex scroll-mt-6 flex-col gap-4" data-testid="assets-sources">
      <h2 className="flex items-center gap-2 text-title font-semibold">
        <PlugIcon className="size-[18px] text-2" aria-hidden />
        {a.sources}
      </h2>
      <div className="flex flex-col gap-2">
        <h3 className="text-body font-medium">{a.ibkr.title}</h3>
        {ibkr.configured ? (
          <p className="text-body text-2">
            {a.ibkr.ready} <span className="text-meta text-2">{ibkrSyncedAt ? fmt(a.lastSynced, { time: shortDateTime(ibkrSyncedAt, locale) }) : a.neverSynced}</span>
          </p>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-5" data-testid="ibkr-setup">
            <p className="text-body">{a.ibkr.setupIntro}</p>
            <Link href="/settings?tab=connections" className="self-start text-body text-primary underline-offset-4 hover:underline">
              {a.ibkr.setupLink}
            </Link>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-body font-medium">{a.plaid.title}</h3>
        <p className="text-body text-2">{a.plaid.intro}</p>
        {plaid.configured ? (
          <>
            <ResumePendingExchange />
            <ConnectBrokerage environment={plaid.defaultEnvironment} primary={brokerages.length === 0} />
            {brokerages.length > 0 && <BankConnections connections={brokerages} environments={plaid.environments} />}
          </>
        ) : (
          <>
            <p className="text-body text-2">
              {a.plaid.notConfigured}{" "}
              <Link href="/settings?tab=connections" className="text-primary underline-offset-4 hover:underline">
                {a.plaid.setupLink}
              </Link>
            </p>
            {brokerages.length > 0 && <BankConnections connections={brokerages} environments={null} />}
          </>
        )}
      </div>
    </section>
  );
}
