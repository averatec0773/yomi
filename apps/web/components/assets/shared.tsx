import type { AccountBalanceView, NetWorth, NetWorthParts, NetWorthRange } from "@yomi/core";
import { Money } from "@/components/money";
import { Segmented } from "@/components/ui-kit/segmented";
import { fmt } from "@/i18n";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { rich } from "@/i18n/rich";
import { dayLabel } from "@/lib/month";
import type { StartingBalanceAccount } from "./starting-balance";

export const VIEWS = ["all", "cash", "investments"] as const;
export type AssetsView = (typeof VIEWS)[number];
export const RANGES: NetWorthRange[] = ["1m", "3m", "1y", "all"];
export const TARGETS = ["USD", "CNY"] as const;
export type Target = (typeof TARGETS)[number];

export interface AssetsParams {
  view: AssetsView;
  range: NetWorthRange;
  currency: Target;
  chart: "value" | "pnl";
}

/** /assets URL for these params, leaving defaults out. */
export function assetsHref(p: AssetsParams, patch: Partial<AssetsParams> = {}): string {
  const q = { ...p, ...patch };
  const sp = new URLSearchParams();
  if (q.view !== "all") sp.set("view", q.view);
  if (q.range !== "3m") sp.set("range", q.range);
  if (q.currency !== "USD") sp.set("currency", q.currency);
  if (q.chart !== "value") sp.set("chart", q.chart);
  const s = sp.toString();
  return s ? `/assets?${s}` : "/assets";
}

/** 1M · 3M · 1Y · All as link segments (the URL is the state). */
export function RangeChips({ params, t }: { params: AssetsParams; t: Dictionary }) {
  return (
    <Segmented
      mode="links"
      label={t.assets.ranges.label}
      value={params.range}
      options={RANGES.map((r) => ({ value: r, label: t.assets.ranges[r], href: assetsHref(params, { range: r }) }))}
    />
  );
}

/** USD · CNY: the currency the converted numbers are shown in. */
export function CurrencySwitch({ params, t }: { params: AssetsParams; t: Dictionary }) {
  return (
    <Segmented
      mode="links"
      label={t.assets.currencyNav}
      value={params.currency}
      options={TARGETS.map((c) => ({ value: c, label: c, href: assetsHref(params, { currency: c }) }))}
    />
  );
}

/** "in USD · CNY at 7.1 on Sep 29" for a converted total. */
export function RateLine({ nw, t, locale }: { nw: NetWorth; t: Dictionary; locale: Locale }) {
  const c = nw.converted;
  if (!c) return null;
  const date = dayLabel(c.fx.date, locale);
  return (
    <span data-testid="assets-rate">
      {[fmt(t.assets.inCurrency, { currency: c.currency }), ...c.fx.rates.map((r) => fmt(t.assets.rateAt, { from: r.from, rate: r.inverse, date }))].map((part, i) => (
        <span key={part}>
          {i > 0 && " · "}
          <span className="whitespace-nowrap">{part}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The numbers the page can state in one currency: the converted parts when FX is there, else the only
 * currency's parts; null when several currencies exist and no rate is known (never summed then).
 */
export function oneCurrency(nw: NetWorth): { currency: string; parts: NetWorthParts; changeMinor: number | null } | null {
  if (nw.converted) return { currency: nw.converted.currency, parts: nw.converted, changeMinor: nw.converted.changeMinor };
  if (nw.currencies.length === 1) {
    const c = nw.currencies[0]!;
    return { currency: c.currency, parts: c, changeMinor: c.changeMinor };
  }
  return null;
}

/** "Cash flow this period −$1,191.20 · Open Analysis": income minus spending per currency, from Analysis. */
export function cashFlowText(flows: { currency: string; minor: number }[] | null, t: Dictionary) {
  if (!flows || flows.length === 0) return t.assets.cashFlowNone;
  return rich(t.assets.cashFlow, {
    amount: (
      <>
        {flows.map((f, i) => (
          <span key={f.currency}>
            {i > 0 && " · "}
            <Money minor={f.minor} currency={f.currency} sign="signed" showCode={flows.length > 1} />
          </span>
        ))}
      </>
    ),
  });
}

/** Accounts a starting balance can be set for: everything a bank connection does not feed. */
export function startingBalanceAccounts(accounts: AccountBalanceView[]): StartingBalanceAccount[] {
  return accounts.filter((a) => !a.plaidLinked).map((a) => ({ id: a.id, name: a.name, currency: a.currency, startingBalance: a.startingBalance }));
}
