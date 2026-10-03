import type { BankConnectionView } from "@yomi/contracts";
import {
  convertOverview,
  type ConvertedTotals,
  type FxTable,
  getCurrentUser,
  getFxRates,
  InvestError,
  isDate,
  listConnections,
  NET_WORTH_RANGES,
  netWorth,
  type NetWorthRange,
  resolveIbkrConfig,
  resolvePlaidConfig,
  resolvePlaidProvider,
  portfolioOverview,
  rangeOverview,
  recentInvestmentActivity,
} from "@yomi/core";
import { CalendarIcon } from "lucide-react";
import { connection } from "next/server";
import { AssetsSyncButton } from "@/components/assets/assets-sync-button";
import { type AssetsParams, assetsHref, TARGETS, VIEWS } from "@/components/assets/shared";
import { AllView, type AssetsViewProps, CashView, InvestmentsView } from "@/components/assets/views";
import { PageHeader } from "@/components/ui-kit/page-header";
import { Segmented } from "@/components/ui-kit/segmented";
import { fmt } from "@/i18n";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { dayLabel } from "@/lib/month";
import { getToday } from "@/lib/settings";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t.assets.metaTitle };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * /assets: stocks at a point in time plus their history (Analysis shows flows over a period). `?view=all|cash|investments`,
 * `?range=1m|3m|1y|all`, `?currency=USD|CNY` for converted totals, `?chart=value|pnl` on Investments, `?asOf=`.
 */
export default async function AssetsPage({ searchParams }: PageProps<"/assets">) {
  await connection();
  const sp = await searchParams;
  const { locale, t } = await getI18n();
  const a = t.assets;
  const db = await getDb();
  const user = getCurrentUser();
  const today = await getToday();

  const params: AssetsParams = {
    view: VIEWS.find((v) => v === first(sp.view)) ?? "all",
    range: NET_WORTH_RANGES.find((r) => r === first(sp.range)) ?? ("3m" as NetWorthRange),
    currency: TARGETS.find((c) => c === first(sp.currency)?.toUpperCase()) ?? "USD",
    chart: first(sp.chart) === "pnl" ? "pnl" : "value",
  };
  const asOfParam = first(sp.asOf);
  const asOf = asOfParam && isDate(asOfParam) && asOfParam <= today ? asOfParam : undefined;

  const nw = await netWorth(db, user, { asOf, range: params.range, currency: params.currency });
  const o = await portfolioOverview(db, user, { asOf: nw.asOf });
  let fx: FxTable | null = null;
  let holdingsConverted: ConvertedTotals | null = null;
  if (nw.converted && o.totals.length) {
    try {
      fx = await getFxRates(db, user, [...o.totals.map((x) => x.currency), params.currency]);
      holdingsConverted = convertOverview(o, params.currency, fx);
    } catch (e) {
      if (!(e instanceof InvestError)) throw e;
    }
  }

  // Flows over the history range come from Analysis (income minus spending, per currency).
  let cashFlow: { currency: string; minor: number }[] | null = null;
  try {
    const r = await rangeOverview(db, user, { from: nw.from, to: nw.asOf }, { today });
    cashFlow = r.currencies.filter((c) => c.incomeMinor || c.spendingMinor).map((c) => ({ currency: c.currency, minor: c.incomeMinor - c.spendingMinor }));
  } catch {
    // a range Analysis does not take (over 5 years): the link goes without an amount
  }

  const ibkr = await resolveIbkrConfig(db, user);
  const plaid = await resolvePlaidConfig(db);
  const connections = (await listConnections(db, user, await resolvePlaidProvider(db))) as BankConnectionView[];
  const brokerages = connections.filter((c) => c.kind === "brokerage");
  const canSync = ibkr.configured || (plaid.configured && connections.some((c) => c.status !== "disconnected"));

  const props: AssetsViewProps = {
    params,
    nw,
    o,
    holdingsConverted,
    fx,
    cashFlow,
    analysisHref: `/analysis?${new URLSearchParams({ from: nw.from, to: nw.asOf }).toString()}`,
    activity: params.view === "investments" ? await recentInvestmentActivity(db, user) : [],
    brokerages,
    plaid: { configured: plaid.configured, defaultEnvironment: plaid.defaultEnvironment, environments: plaid.environments },
    ibkr: { configured: ibkr.configured, missing: ibkr.missing },
    today,
    t,
    locale,
  };

  return (
    <div>
      <PageHeader
        title={a.title}
        controls={
          <Segmented
            mode="links"
            label={a.views.label}
            value={params.view}
            options={VIEWS.map((v) => ({ value: v, label: a.views[v], href: assetsHref(params, { view: v }) }))}
          />
        }
        actions={
          <>
            <span className="inline-flex items-center gap-1.5 text-meta text-2" data-testid="assets-header-asof">
              <CalendarIcon className="size-3.5" aria-hidden />
              {fmt(a.asOf, { date: dayLabel(nw.asOf, locale) })}
            </span>
            {canSync && <AssetsSyncButton />}
          </>
        }
      />
      {params.view === "cash" ? <CashView {...props} /> : params.view === "investments" ? <InvestmentsView {...props} /> : <AllView {...props} />}
    </div>
  );
}
