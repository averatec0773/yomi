// Shapes of the Plaid API objects this project reads. Field names follow the docs verbatim
// (https://plaid.com/docs/api/accounts/, https://plaid.com/docs/api/products/transactions/).

export type PlaidEnvironment = "sandbox" | "production";

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  /** Last 2 to 4 characters of the account number. */
  mask: string | null;
  /** depository | credit | loan | investment | other */
  type: string;
  subtype: string | null;
  balances?: {
    /** Depository: money in the account; credit and loan: the amount owed (positive). */
    current?: number | null;
    available?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
    unofficial_currency_code?: string | null;
  } | null;
}

export interface PlaidItem {
  item_id: string;
  institution_id?: string | null;
  institution_name?: string | null;
}

export interface PlaidPersonalFinanceCategory {
  primary: string;
  detailed: string;
  confidence_level?: string | null;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Positive = money moves out of the account, negative = money moves in (all account types). */
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  /** Posted date (or the date it occurred, for pending rows), YYYY-MM-DD. */
  date: string;
  authorized_date: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  merchant_name: string | null;
  name: string;
  personal_finance_category?: PlaidPersonalFinanceCategory | null;
  payment_channel?: string | null;
}

export interface PlaidRemovedTransaction {
  transaction_id: string;
  account_id?: string;
}

export interface PlaidAccountsGetResponse {
  accounts: PlaidAccount[];
  item: PlaidItem;
  request_id: string;
}

export interface PlaidTransactionsSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  accounts?: PlaidAccount[];
  next_cursor: string;
  has_more: boolean;
  transactions_update_status?: string;
  request_id: string;
}

/** Plaid error body (https://plaid.com/docs/errors/). */
export interface PlaidErrorBody {
  error_type: string;
  error_code: string;
  error_message: string;
  display_message: string | null;
  request_id?: string;
}

/** What Plaid Link passes to onSuccess as `metadata` (https://plaid.com/docs/link/web/). */
export interface PlaidLinkMetadata {
  institution: { name: string; institution_id: string } | null;
  accounts: { id: string; name: string; mask: string | null; type: string; subtype: string | null }[];
  link_session_id?: string;
}

/** One Item added in a Link session, from /link/token/get `link_sessions[].results.item_add_results[]`. */
export interface PlaidItemAddResult {
  public_token: string;
  accounts?: { id: string; name?: string | null; mask?: string | null; type?: string | null; subtype?: string | null }[];
  institution?: { name?: string | null; institution_id?: string | null } | null;
}

/**
 * `link_sessions[]` of /link/token/get (https://plaid.com/docs/api/link/#linktokenget). Observed in
 * Sandbox 2026-09-29 for standard Link: `results.item_add_results` is filled as soon as the bank
 * login succeeds (before Link's last "Share data" pane, `finished_at` still absent); an exit adds
 * `exit: { error, metadata: { status: "connected", link_session_id, … } }` and `finished_at`.
 */
export interface PlaidLinkSession {
  link_session_id: string;
  started_at?: string | null;
  finished_at?: string | null;
  on_success?: { public_token?: string | null; metadata?: { institution?: { name?: string | null } | null } | null } | null;
  on_exit?: { error?: { error_code?: string | null } | null; metadata?: { status?: string | null; exit_status?: string | null } | null } | null;
  exit?: { exit_status?: string | null; error?: { error_code?: string | null } | null; metadata?: { status?: string | null } | null } | null;
  results?: { item_add_results?: PlaidItemAddResult[] | null } | null;
}

// Investments (https://plaid.com/docs/api/products/investments/). Numbers are JSON doubles.

export interface PlaidSecurity {
  security_id: string;
  isin?: string | null;
  cusip?: string | null;
  ticker_symbol?: string | null;
  name?: string | null;
  /** cash | cryptocurrency | derivative | equity | etf | fixed income | loan | mutual fund | other */
  type?: string | null;
  subtype?: string | null;
  is_cash_equivalent?: boolean | null;
  close_price?: number | null;
  close_price_as_of?: string | null;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  option_contract?: { contract_type?: string | null; expiration_date?: string | null; strike_price?: number | null; underlying_security_ticker?: string | null } | null;
}

export interface PlaidHolding {
  account_id: string;
  security_id: string;
  institution_price: number;
  institution_price_as_of?: string | null;
  institution_value: number;
  /** Total cost of the whole holding (not per share); null when unknown. */
  cost_basis?: number | null;
  quantity: number;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
}

export interface PlaidInvestmentsHoldingsResponse {
  accounts: PlaidAccount[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
  item: PlaidItem;
  request_id: string;
}

export interface PlaidInvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  security_id?: string | null;
  date: string;
  name?: string | null;
  /** Positive for buys, negative for sells. */
  quantity: number;
  /** Positive when cash is debited (purchases), negative when credited (sales, dividends). */
  amount: number;
  price?: number | null;
  fees?: number | null;
  /** buy | sell | cancel | cash | fee | transfer */
  type: string;
  subtype?: string | null;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
}

export interface PlaidInvestmentsTransactionsResponse {
  accounts: PlaidAccount[];
  securities: PlaidSecurity[];
  investment_transactions: PlaidInvestmentTransaction[];
  total_investment_transactions: number;
  item: PlaidItem;
  request_id: string;
}

export interface PlaidLinkTokenGetResponse {
  link_token: string;
  created_at?: string | null;
  expiration?: string | null;
  link_sessions?: PlaidLinkSession[] | null;
  request_id: string;
}
