import { CodedError, type ErrorKind, type MessageParams } from "@yomi/importers";

/** Stable codes the API returns and the UI translates, with the kind of each. Messages are English, for logs. */
const INVEST_ERROR_KINDS = {
  invest_ibkr_not_configured: "conflict",
  invest_ibkr_token_expired: "conflict",
  invest_ibkr_token_invalid: "conflict",
  invest_ibkr_query_invalid: "conflict",
  invest_ibkr_ip_restricted: "conflict",
  invest_ibkr_rate_limited: "rate_limited",
  invest_ibkr_unavailable: "unavailable",
  invest_ibkr_error: "unavailable",
  invest_ibkr_statement_invalid: "unavailable",
  invest_ibkr_range_invalid: "invalid",
  invest_ibkr_history_days_invalid: "invalid",
  invest_ibkr_pull_too_soon: "rate_limited",
  invest_ibkr_pull_backoff: "rate_limited",
  invest_ibkr_pull_running: "conflict",
  invest_flex_in_progress_timeout: "timeout",
  invest_ibkr_test_timeout: "timeout",
  invest_plaid_not_configured: "conflict",
  invest_plaid_error: "unavailable",
  invest_fx_unavailable: "unavailable",
  invest_fx_currency_unsupported: "invalid",
} as const satisfies Record<string, ErrorKind>;

export type InvestErrorCode = keyof typeof INVEST_ERROR_KINDS;

export class InvestError extends CodedError {
  declare readonly code: InvestErrorCode;
  constructor(code: InvestErrorCode, message: string, params: MessageParams = {}) {
    super(INVEST_ERROR_KINDS[code], code, message, params);
    this.name = "InvestError";
  }
}
