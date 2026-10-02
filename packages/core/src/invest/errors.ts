import { CodedError, type MessageParams } from "@yomi/importers";

/** Stable codes the API returns and the UI translates. Messages are English, for logs. */
export type InvestErrorCode =
  | "invest_ibkr_not_configured"
  | "invest_ibkr_token_expired"
  | "invest_ibkr_token_invalid"
  | "invest_ibkr_query_invalid"
  | "invest_ibkr_ip_restricted"
  | "invest_ibkr_rate_limited"
  | "invest_ibkr_unavailable"
  | "invest_ibkr_error"
  | "invest_ibkr_statement_invalid"
  | "invest_ibkr_range_invalid"
  | "invest_ibkr_history_days_invalid"
  | "invest_ibkr_pull_too_soon"
  | "invest_ibkr_pull_backoff"
  | "invest_ibkr_pull_running"
  | "invest_flex_in_progress_timeout"
  | "invest_ibkr_test_timeout"
  | "invest_plaid_not_configured"
  | "invest_plaid_error"
  | "invest_fx_unavailable"
  | "invest_fx_currency_unsupported";

export class InvestError extends CodedError {
  declare readonly code: InvestErrorCode;
  constructor(code: InvestErrorCode, message: string, params: MessageParams = {}) {
    super(code, message, params);
    this.name = "InvestError";
  }
}
