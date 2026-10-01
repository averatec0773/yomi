import { z } from "zod";
import { MessageParams, Notice } from "./common";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Currency = z.string().regex(/^[A-Z]{3}$/);
export const InvestProvider = z.enum(["ibkr", "plaid"]);
export type InvestProvider = z.infer<typeof InvestProvider>;

/** GET /api/invest/config: which sources are set up. Never carries a token, query id or secret. */
export const InvestConfig = z.object({
  ibkr: z.object({ configured: z.boolean(), missing: z.array(z.string()) }),
  plaid: z.object({
    configured: z.boolean(),
    /** Plaid logins made through the "connect a brokerage" flow (kind brokerage), any status. */
    brokerageConnections: z.int(),
  }),
  fx: z.object({ source: z.literal("frankfurter") }),
});
export type InvestConfig = z.infer<typeof InvestConfig>;

/** GET /api/invest/accounts */
export const InvestAccountView = z.object({
  id: z.int(),
  provider: InvestProvider,
  name: z.string(),
  currency: z.string(),
  bankConnectionId: z.int().nullable(),
  latestAsOf: IsoDate.nullable(),
});
export type InvestAccountView = z.infer<typeof InvestAccountView>;
export const InvestAccountList = z.object({ accounts: z.array(InvestAccountView) });
export type InvestAccountList = z.infer<typeof InvestAccountList>;

/** GET /api/invest/overview?asOf=YYYY-MM-DD&currency=CNY */
export const InvestOverviewQuery = z.object({
  asOf: IsoDate.optional(),
  /** Also total everything in this currency (FX from Frankfurter, cached daily). */
  currency: Currency.optional(),
});
export type InvestOverviewQuery = z.infer<typeof InvestOverviewQuery>;

export const CurrencyTotalsView = z.object({
  currency: z.string(),
  marketValueMinor: z.int(),
  costBasisMinor: z.int(),
  unrealizedPnlMinor: z.int(),
  previousMarketValueMinor: z.int().nullable(),
  changeMinor: z.int().nullable(),
});
export type CurrencyTotalsView = z.infer<typeof CurrencyTotalsView>;

export const PositionView = z.object({
  positionKey: z.string(),
  securityId: z.int().nullable(),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  type: z.string().nullable(),
  currency: z.string(),
  /** Exact decimal strings as the source sent them. */
  quantity: z.string(),
  price: z.string(),
  marketValueMinor: z.int(),
  costBasisMinor: z.int().nullable(),
  unrealizedPnlMinor: z.int().nullable(),
  previousMarketValueMinor: z.int().nullable(),
  changeMinor: z.int().nullable(),
});
export type PositionView = z.infer<typeof PositionView>;

export const InvestAccountOverview = z.object({
  id: z.int(),
  provider: InvestProvider,
  name: z.string(),
  currency: z.string(),
  bankConnectionId: z.int().nullable(),
  asOf: IsoDate.nullable(),
  previousAsOf: IsoDate.nullable(),
  /** When the snapshot shown was written (ISO time). */
  syncedAt: z.string().nullable(),
  totals: z.array(CurrencyTotalsView),
  positions: z.array(PositionView),
});
export type InvestAccountOverview = z.infer<typeof InvestAccountOverview>;

export const ConvertedTotalsView = z.object({
  currency: z.string(),
  marketValueMinor: z.int(),
  costBasisMinor: z.int(),
  unrealizedPnlMinor: z.int(),
  changeMinor: z.int().nullable(),
  fx: z.object({
    source: z.literal("frankfurter"),
    base: z.string(),
    /** Publication date of the rates. */
    date: z.string(),
    /** Units of the target currency per 1 unit of `from` (display, 6 decimals). */
    rates: z.array(z.object({ from: z.string(), rate: z.string() })),
  }),
});
export type ConvertedTotalsView = z.infer<typeof ConvertedTotalsView>;

export const InvestOverview = z.object({
  asOf: IsoDate.nullable(),
  accounts: z.array(InvestAccountOverview),
  totals: z.array(CurrencyTotalsView),
  converted: ConvertedTotalsView.nullable(),
  /** Set when `currency` was asked for but FX rates were unavailable (code invest_fx_unavailable or invest_fx_currency_unsupported). */
  fxError: Notice.nullable(),
});
export type InvestOverview = z.infer<typeof InvestOverview>;

/** POST /api/invest/sync */
export const InvestSyncBody = z.object({ provider: z.enum(["ibkr", "plaid", "all"]).default("all") });
export type InvestSyncBody = z.infer<typeof InvestSyncBody>;

export const InvestSyncItemView = z.object({
  provider: InvestProvider,
  connectionId: z.int().nullable(),
  asOf: IsoDate,
  accounts: z.int(),
  positions: z.int(),
  cashBalances: z.int(),
  transactionsNew: z.int(),
  transactionsUpdated: z.int(),
  totals: z.record(z.string(), z.int()),
  warnings: z.array(Notice),
  /** IBKR: the trading day whose statement should exist by now; null for Plaid. */
  expectedAsOf: IsoDate.nullable(),
  /** True when IBKR returned a statement older than expectedAsOf (not published yet, or a holiday). */
  stale: z.boolean(),
});
export type InvestSyncItemView = z.infer<typeof InvestSyncItemView>;

export const InvestSyncResult = z.object({
  results: z.array(InvestSyncItemView),
  /** Per-pull failures with stable codes (invest_ibkr_token_expired, provider_reconnect, ...). */
  errors: z.array(z.object({ provider: InvestProvider, connectionId: z.int().nullable(), code: z.string(), params: MessageParams, message: z.string() })),
  skipped: z.array(InvestProvider),
});
export type InvestSyncResult = z.infer<typeof InvestSyncResult>;
