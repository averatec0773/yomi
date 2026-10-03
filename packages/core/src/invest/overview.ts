import { bankConnections, type Db, holdingSnapshots, investmentAccounts, securities } from "@yomi/db";
import { and, asc, eq, lt, lte, max } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { convertMinor, convertWithFx, crossRate, type FxFailure, type FxTable } from "./fx";

export interface PositionView {
  positionKey: string;
  /** Null for a cash balance. */
  securityId: number | null;
  symbol: string | null;
  name: string | null;
  type: string | null;
  currency: string;
  /** Exact decimal strings from the source. */
  quantity: string;
  price: string;
  marketValueMinor: number;
  costBasisMinor: number | null;
  /** marketValue − costBasis; null when the cost is unknown (and for cash). */
  unrealizedPnlMinor: number | null;
  /** Same position in the previous snapshot of the account; null when it was not held then. */
  previousMarketValueMinor: number | null;
  changeMinor: number | null;
}

export interface CurrencyTotals {
  currency: string;
  marketValueMinor: number;
  /** Sum over positions with a known cost. */
  costBasisMinor: number;
  unrealizedPnlMinor: number;
  /** Market value of the previous snapshot(s); null when no account in this currency has one. */
  previousMarketValueMinor: number | null;
  changeMinor: number | null;
}

export interface AccountOverview {
  id: number;
  provider: "ibkr" | "plaid";
  name: string;
  currency: string;
  bankConnectionId: number | null;
  /** Snapshot shown (latest on or before the requested date); null when the account has none yet. */
  asOf: string | null;
  previousAsOf: string | null;
  /** When the snapshot shown was written (ISO time of the last successful pull for that day). */
  syncedAt: string | null;
  totals: CurrencyTotals[];
  positions: PositionView[];
}

export interface ConvertedTotals {
  currency: string;
  marketValueMinor: number;
  costBasisMinor: number;
  unrealizedPnlMinor: number;
  changeMinor: number | null;
  fx: { source: FxTable["source"]; base: string; date: string; rates: { from: string; rate: string }[] };
}

export interface PortfolioOverview {
  /** The requested date, or the latest snapshot date overall; null when nothing is stored. */
  asOf: string | null;
  accounts: AccountOverview[];
  /** All accounts, per currency. */
  totals: CurrencyTotals[];
  /** Totals in one currency, when asked for and FX rates were available. */
  converted: ConvertedTotals | null;
}

type SnapRow = { snap: typeof holdingSnapshots.$inferSelect; sec: typeof securities.$inferSelect | null };

async function snapshotRows(db: Db, accountId: number, asOf: string): Promise<SnapRow[]> {
  return await db
    .select({ snap: holdingSnapshots, sec: securities })
    .from(holdingSnapshots)
    .leftJoin(securities, eq(securities.id, holdingSnapshots.securityId))
    .where(and(eq(holdingSnapshots.investmentAccountId, accountId), eq(holdingSnapshots.asOf, asOf)))
    .orderBy(asc(holdingSnapshots.id));
}

async function latestOnOrBefore(db: Db, accountId: number, date: string | null, strict = false): Promise<string | null> {
  const cond = date == null ? undefined : strict ? lt(holdingSnapshots.asOf, date) : lte(holdingSnapshots.asOf, date);
  const r = (await db
    .select({ asOf: max(holdingSnapshots.asOf) })
    .from(holdingSnapshots)
    .where(and(eq(holdingSnapshots.investmentAccountId, accountId), cond))
    .limit(1))[0];
  return r?.asOf ?? null;
}

function addTotals(into: Map<string, CurrencyTotals>, t: CurrencyTotals): void {
  const cur = into.get(t.currency);
  if (!cur) {
    into.set(t.currency, { ...t });
    return;
  }
  cur.marketValueMinor += t.marketValueMinor;
  cur.costBasisMinor += t.costBasisMinor;
  cur.unrealizedPnlMinor += t.unrealizedPnlMinor;
  if (t.previousMarketValueMinor != null) cur.previousMarketValueMinor = (cur.previousMarketValueMinor ?? 0) + t.previousMarketValueMinor;
  if (t.changeMinor != null) cur.changeMinor = (cur.changeMinor ?? 0) + t.changeMinor;
}

const sortTotals = (m: Map<string, CurrencyTotals>) => [...m.values()].sort((a, b) => a.currency.localeCompare(b.currency));

/**
 * Holdings per account as of `asOf` (default: each account's latest snapshot), per-currency totals
 * (market value, cost, unrealized P/L) and the change against each account's previous snapshot.
 * Pure reads; conversion to one currency is `convertOverview`.
 */
export async function portfolioOverview(db: Db, user: CurrentUser, opts: { asOf?: string } = {}): Promise<PortfolioOverview> {
  const accts = await db.select().from(investmentAccounts).where(eq(investmentAccounts.userId, user.id)).orderBy(asc(investmentAccounts.id));
  const grand = new Map<string, CurrencyTotals>();
  const accounts: AccountOverview[] = [];
  let latest: string | null = null;
  for (const a of accts) {
    const asOf = await latestOnOrBefore(db, a.id, opts.asOf ?? null);
    const previousAsOf = asOf ? await latestOnOrBefore(db, a.id, asOf, true) : null;
    const view: AccountOverview = {
      id: a.id,
      provider: a.provider,
      name: a.name,
      currency: a.currency,
      bankConnectionId: a.bankConnectionId,
      asOf,
      previousAsOf,
      syncedAt: null,
      totals: [],
      positions: [],
    };
    accounts.push(view);
    if (!asOf) continue;
    if (!latest || asOf > latest) latest = asOf;
    const prev = new Map<string, number>();
    const prevByCurrency = new Map<string, number>();
    if (previousAsOf) {
      for (const { snap } of (await snapshotRows(db, a.id, previousAsOf))) {
        prev.set(snap.positionKey, snap.marketValueMinor);
        prevByCurrency.set(snap.currency, (prevByCurrency.get(snap.currency) ?? 0) + snap.marketValueMinor);
      }
    }
    const totals = new Map<string, CurrencyTotals>();
    for (const { snap, sec } of (await snapshotRows(db, a.id, asOf))) {
      if (!view.syncedAt || snap.createdAt > view.syncedAt) view.syncedAt = snap.createdAt;
      const pnl = snap.costBasisMinor == null ? null : snap.marketValueMinor - snap.costBasisMinor;
      const p = prev.get(snap.positionKey) ?? null;
      view.positions.push({
        positionKey: snap.positionKey,
        securityId: snap.securityId,
        symbol: sec?.symbol ?? (snap.securityId == null ? snap.currency : null),
        name: sec?.name ?? null,
        type: sec?.type ?? (snap.securityId == null ? "cash" : null),
        currency: snap.currency,
        quantity: snap.quantity,
        price: snap.price,
        marketValueMinor: snap.marketValueMinor,
        costBasisMinor: snap.costBasisMinor,
        unrealizedPnlMinor: pnl,
        previousMarketValueMinor: previousAsOf ? p : null,
        changeMinor: previousAsOf ? snap.marketValueMinor - (p ?? 0) : null,
      });
      addTotals(totals, {
        currency: snap.currency,
        marketValueMinor: snap.marketValueMinor,
        costBasisMinor: snap.costBasisMinor ?? 0,
        unrealizedPnlMinor: pnl ?? 0,
        previousMarketValueMinor: null,
        changeMinor: null,
      });
    }
    if (previousAsOf) {
      // Currencies held only in the previous snapshot still count toward the change.
      for (const [currency, v] of prevByCurrency) {
        if (!totals.has(currency)) addTotals(totals, { currency, marketValueMinor: 0, costBasisMinor: 0, unrealizedPnlMinor: 0, previousMarketValueMinor: null, changeMinor: null });
        const t = totals.get(currency)!;
        t.previousMarketValueMinor = v;
      }
      for (const t of totals.values()) {
        t.previousMarketValueMinor ??= 0;
        t.changeMinor = t.marketValueMinor - t.previousMarketValueMinor;
      }
    }
    view.totals = sortTotals(totals);
    for (const t of view.totals) addTotals(grand, t);
  }
  return { asOf: opts.asOf ?? latest, accounts, totals: sortTotals(grand), converted: null };
}

/** Currencies an overview needs FX for. */
export function overviewCurrencies(o: PortfolioOverview): string[] {
  return o.totals.map((t) => t.currency);
}

/**
 * Sums the per-currency totals in `currency`: each currency total is converted once (one rounding
 * per currency), then added. The FX table's date and the cross rates used are included.
 */
export function convertOverview(o: PortfolioOverview, currency: string, fx: FxTable): ConvertedTotals {
  const to = currency.toUpperCase();
  const out: ConvertedTotals = {
    currency: to,
    marketValueMinor: 0,
    costBasisMinor: 0,
    unrealizedPnlMinor: 0,
    changeMinor: null,
    fx: { source: fx.source, base: fx.base, date: fx.date, rates: [] },
  };
  for (const t of o.totals) {
    out.marketValueMinor += convertMinor(t.marketValueMinor, t.currency, to, fx);
    out.costBasisMinor += convertMinor(t.costBasisMinor, t.currency, to, fx);
    out.unrealizedPnlMinor += convertMinor(t.unrealizedPnlMinor, t.currency, to, fx);
    if (t.changeMinor != null) out.changeMinor = (out.changeMinor ?? 0) + convertMinor(t.changeMinor, t.currency, to, fx);
    if (t.currency !== to) out.fx.rates.push({ from: t.currency, rate: crossRate(t.currency, to, fx) });
  }
  return out;
}

/**
 * The holdings overview on `asOf` (default: the latest snapshot), totalled in `currency` too when asked for. An FX
 * failure leaves `converted` null and fills `fxError`, as net worth does. What GET /api/invest/overview and MCP read.
 */
export async function investOverview(
  db: Db,
  user: CurrentUser,
  opts: { asOf?: string; currency?: string },
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<PortfolioOverview & { fxError: FxFailure | null }> {
  const o = await portfolioOverview(db, user, { asOf: opts.asOf });
  const currency = opts.currency;
  if (!currency || o.totals.length === 0) return { ...o, fxError: null };
  const fxError = await convertWithFx(db, user, [...overviewCurrencies(o), currency], deps, (fx) => {
    o.converted = convertOverview(o, currency, fx);
  });
  return { ...o, fxError };
}

export interface InvestmentAccountSummary {
  id: number;
  provider: "ibkr" | "plaid";
  name: string;
  currency: string;
  bankConnectionId: number | null;
  latestAsOf: string | null;
}

export async function listInvestmentAccounts(db: Db, user: CurrentUser): Promise<InvestmentAccountSummary[]> {
  const rows = await db.select().from(investmentAccounts).where(eq(investmentAccounts.userId, user.id)).orderBy(asc(investmentAccounts.id));
  const out: InvestmentAccountSummary[] = [];
  for (const a of rows) {
    out.push({
      id: a.id,
      provider: a.provider,
      name: a.name,
      currency: a.currency,
      bankConnectionId: a.bankConnectionId,
      latestAsOf: await latestOnOrBefore(db, a.id, null),
    });
  }
  return out;
}

/** Plaid logins made through the "connect a brokerage" flow, any status. */
export async function brokerageConnectionCount(db: Db, user: CurrentUser): Promise<number> {
  return (await db
    .select({ id: bankConnections.id })
    .from(bankConnections)
    .where(and(eq(bankConnections.userId, user.id), eq(bankConnections.kind, "brokerage")))
    ).length;
}
