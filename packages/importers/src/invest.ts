// Normalized brokerage data shared by the IBKR Flex and Plaid Investments mappers. Every quantity,
// price and amount is the source's exact decimal string (see util/decimal.ts); conversion to integer
// minor units happens once, in core, when rows are stored.
import type { Notice } from "./errors";

export type InvestSourceId = "ibkr" | "plaid";
export type InvestTxnKind = "buy" | "sell" | "dividend" | "interest" | "fee" | "transfer" | "other";

export interface InvestAccountRow {
  externalId: string;
  name: string;
  /** Base currency of the account. */
  currency: string;
}

export interface InvestSecurityRow {
  externalId: string;
  symbol: string | null;
  name: string | null;
  /** Provider's own type label (IBKR assetCategory STK/OPT/…, Plaid equity/etf/…). */
  type: string | null;
  currency: string;
  isin: string | null;
  cusip: string | null;
  /** Contract multiplier (options "100"); null means 1. */
  multiplier: string | null;
}

export interface InvestHoldingRow {
  accountExternalId: string;
  /** Null for a cash balance. */
  securityExternalId: string | null;
  currency: string;
  quantity: string;
  price: string;
  /** Market value in `currency`, as reported by the source (quantity × price × multiplier). */
  marketValue: string;
  /** Total cost of the position in `currency`; null when the source does not know it. */
  costBasis: string | null;
  raw: Record<string, unknown>;
}

export interface InvestTxnRow {
  accountExternalId: string;
  securityExternalId: string | null;
  /** Stable per account (IBKR transactionID, Plaid investment_transaction_id). */
  externalId: string;
  /** YYYY-MM-DD */
  date: string;
  type: InvestTxnKind;
  quantity: string | null;
  /** Cash effect on the account: positive = cash in (sale, dividend), negative = cash out (purchase, fee). */
  amount: string;
  currency: string;
  description: string | null;
  raw: Record<string, unknown>;
}

/** Net asset value of an account at the close of `date`, in the account's base currency (IBKR NAV in Base). */
export interface InvestNavRow {
  accountExternalId: string;
  /** YYYY-MM-DD */
  date: string;
  currency: string;
  /** Total net asset value, exact decimal string. */
  total: string;
  raw: Record<string, unknown>;
}

/** One provider pull: what the accounts held on `asOf` and the activity that came with it. */
export interface InvestStatement {
  source: InvestSourceId;
  /** YYYY-MM-DD the holdings are valid for. */
  asOf: string;
  accounts: InvestAccountRow[];
  securities: InvestSecurityRow[];
  holdings: InvestHoldingRow[];
  transactions: InvestTxnRow[];
  /** Daily account values over the pulled window, when the source has them (IBKR NAV in Base). */
  navs?: InvestNavRow[];
  /** IBKR: ids of the Flex sections present in the statement (empty ones included), see ibkr/map.ts FLEX_SECTIONS. */
  sections?: string[];
  warnings: Notice[];
}
