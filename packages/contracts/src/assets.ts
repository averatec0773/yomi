import { z } from "zod";
import { Notice } from "./common";
import { InvestSyncResult } from "./invest";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Currency = z.string().regex(/^[A-Z]{3}$/);
export const NetWorthRange = z.enum(["1m", "3m", "1y", "all"]);
export type NetWorthRange = z.infer<typeof NetWorthRange>;
export const BalanceSource = z.enum(["plaid", "statement", "derived", "manual"]);

/** GET /api/assets/net-worth?asOf=YYYY-MM-DD&currency=USD&range=3m */
export const NetWorthQuery = z.object({
  /** Default: today in the user's time zone. */
  asOf: IsoDate.optional(),
  /** Also total everything in this currency (Frankfurter rate, stated with its date). */
  currency: Currency.optional(),
  range: NetWorthRange.optional(),
});
export type NetWorthQuery = z.infer<typeof NetWorthQuery>;

export const NetWorthPartsView = z.object({
  cashMinor: z.int(),
  /** Credit cards: owed, negative. */
  cardsMinor: z.int(),
  holdingsMinor: z.int(),
  pnlMinor: z.int(),
  totalMinor: z.int(),
});
export type NetWorthPartsView = z.infer<typeof NetWorthPartsView>;

export const CurrencyNetWorthView = NetWorthPartsView.extend({ currency: z.string(), changeMinor: z.int().nullable() });

export const AccountBalanceView = z.object({
  id: z.int(),
  name: z.string(),
  kind: z.string(),
  institution: z.string().nullable(),
  last4: z.string().nullable(),
  currency: z.string(),
  class: z.enum(["cash", "card"]),
  plaidLinked: z.boolean(),
  startingBalance: z.object({ amountMinor: z.int(), on: IsoDate }).nullable(),
  balances: z.array(
    z.object({
      currency: z.string(),
      balanceMinor: z.int(),
      changeMinor: z.int().nullable(),
      source: BalanceSource.nullable(),
      sourceAsOf: IsoDate.nullable(),
    }),
  ),
});
export type AccountBalanceView = z.infer<typeof AccountBalanceView>;

export const NetWorthView = z.object({
  asOf: IsoDate,
  range: NetWorthRange,
  from: IsoDate,
  firstDate: IsoDate.nullable(),
  currencies: z.array(CurrencyNetWorthView),
  converted: NetWorthPartsView.extend({
    currency: z.string(),
    changeMinor: z.int().nullable(),
    fx: z.object({ source: z.literal("frankfurter"), date: z.string(), rates: z.array(z.object({ from: z.string(), rate: z.string(), inverse: z.string() })) }),
  }).nullable(),
  fxError: Notice.nullable(),
  series: z.array(z.object({ date: IsoDate, byCurrency: z.record(z.string(), NetWorthPartsView), converted: NetWorthPartsView.nullable() })),
  accounts: z.array(AccountBalanceView),
  hasBalances: z.boolean(),
});
export type NetWorthView = z.infer<typeof NetWorthView>;

/** PUT /api/accounts/:id/starting-balance: the balance at the end of `on` (account currency), or `{ clear: true }`. */
export const StartingBalanceBody = z.union([
  z.object({ amountMinor: z.int(), on: IsoDate }).strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);
export type StartingBalanceBody = z.infer<typeof StartingBalanceBody>;

export const StartingBalanceResult = z.object({
  id: z.int(),
  startingBalance: z.object({ amountMinor: z.int(), on: IsoDate }).nullable(),
});
export type StartingBalanceResult = z.infer<typeof StartingBalanceResult>;

/** POST /api/assets/sync: bank balances (and new rows) from every bank connection, then holdings, then today's snapshots. */
export const AssetsSyncResult = z.object({
  bank: z.object({ connections: z.int(), inserted: z.int(), errors: z.array(z.object({ connectionId: z.int(), message: z.string() })) }).nullable(),
  invest: InvestSyncResult,
});
export type AssetsSyncResult = z.infer<typeof AssetsSyncResult>;
