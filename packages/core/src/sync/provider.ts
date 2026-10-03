import { CodedError, type ErrorKind, type InvestStatement, type NormalizedRow, type SourceId } from "@yomi/importers";

/**
 * Bank aggregator seam. Core sync code only talks to this interface; Plaid is the implementation
 * (./plaid.ts). Implementations are injected (API deps, job runner, tests), never imported by the
 * sync logic.
 */
export type BankProviderId = "plaid";
/** bank: transactions into the ledger; brokerage: investments (holdings) only. */
export type ConnectionKind = "bank" | "brokerage";

export interface ProviderConnection {
  accessToken: string;
  /** Provider's id of the login (Plaid item_id). */
  enrollmentId: string;
  institutionName: string | null;
}

export interface ProviderAccount {
  providerAccountId: string;
  institutionName: string;
  name: string;
  /** Provider's own type, e.g. Plaid "depository" | "credit". */
  type: string;
  subtype: string | null;
  lastFour: string | null;
  currency: string;
  /** Whether money on this account is card credit (credit_card) or cash in a bank (debit_card). */
  ledgerKind: "credit_card" | "debit_card";
  /**
   * Balances as the provider reports them, exact decimal strings in `currency` (Plaid balances.current /
   * available / limit: for credit and loan accounts `current` is the amount owed, positive). Absent when not sent.
   */
  balances?: { current: string | null; available: string | null; limit: string | null };
}

export interface ProviderRow {
  providerAccountId: string;
  /** Posted row, signed with negative = money leaving me. */
  row: NormalizedRow;
}

export interface ChangesResult {
  added: ProviderRow[];
  /** Posted rows whose amount, merchant or date changed at the provider. */
  modified: ProviderRow[];
  /** Transactions the provider deleted (externalId = transaction id). */
  removed: { providerAccountId: string | null; externalId: string }[];
  /** The login's current accounts, when the provider sends them along. */
  accounts: ProviderAccount[] | null;
  /** Opaque, stored on the connection and handed back on the next fetch. */
  nextCursor: string | null;
}

/** One widget session opened with a link token, as the provider reports it server side. */
export interface ProviderLinkSession {
  /** Provider's session id (Plaid link_session_id), what support asks for. */
  linkSessionId: string;
  /** The session ended (success or exit); while false the user may still be in the widget. */
  finished: boolean;
  exitStatus: string | null;
  /** Logins created in the session, each with a one-time token to exchange. */
  items: { publicToken: string; institutionName: string | null }[];
}

type BankProviderErrorReason = "reconnect" | "rate_limited" | "unavailable" | "other";

const PROVIDER_ERROR_KINDS: Record<BankProviderErrorReason, ErrorKind> = {
  reconnect: "conflict",
  rate_limited: "rate_limited",
  unavailable: "unavailable",
  other: "unavailable",
};

/**
 * Normalized provider failure, code `bank_provider_<reason>` with the provider's message as `detail`. `reconnect`
 * means the login must be redone in the provider's widget. `status` and `providerCode` are the provider's own.
 */
export class BankProviderError extends CodedError {
  constructor(
    readonly reason: BankProviderErrorReason,
    message: string,
    readonly status: number | null = null,
    readonly providerCode: string | null = null,
  ) {
    super(PROVIDER_ERROR_KINDS[reason], `bank_provider_${reason}`, message, { detail: message });
    this.name = "BankProviderError";
  }
}

export interface BankProvider {
  id: BankProviderId;
  /** `source` of the rows it returns and of the import batch a sync writes. */
  source: SourceId;
  /** Provider environments this instance can talk to (Plaid: sandbox and/or production). */
  environments: string[];
  /** Environment for new logins when the caller does not name one; always one of `environments`. */
  defaultEnvironment: string;
  /** Environment an access token belongs to, when the token says (Plaid: access-sandbox-…). */
  tokenEnvironment(accessToken: string): string | null;
  /**
   * Short-lived token the browser widget opens with. With `accessToken`: update mode (re-login),
   * routed by the token's environment. Otherwise a new login in `environment` (default: defaultEnvironment).
   */
  createLinkToken(opts: {
    clientUserId: string;
    accessToken?: string;
    environment?: string;
    /** Products a new login asks for: bank → transactions, brokerage → investments. Default bank. */
    kind?: ConnectionKind;
  }): Promise<{ linkToken: string; expiration: string }>;
  /**
   * Sessions opened with a link token and the logins they created, read server side (Plaid
   * /link/token/get). Lets a login made in the widget be saved even if the browser never reported it.
   */
  getLinkSessions(linkToken: string, opts?: { environment?: string }): Promise<ProviderLinkSession[]>;
  /** Trades the widget's one-time public token for a long-lived access token, in `environment` (default: the token's own, else defaultEnvironment). */
  exchangePublicToken(publicToken: string, opts?: { environment?: string }): Promise<{ accessToken: string; enrollmentId: string }>;
  /** Operations on an existing connection talk to the environment its access token belongs to. */
  listAccounts(conn: ProviderConnection): Promise<ProviderAccount[]>;
  /** Changes since `cursor` (null = full history). */
  fetchChanges(conn: ProviderConnection, cursor: string | null): Promise<ChangesResult>;
  /** Revokes the connection at the provider. Already-gone connections resolve normally. */
  disconnect(conn: ProviderConnection): Promise<void>;
  /**
   * Holdings on `asOf` plus investment transactions in [startDate, endDate] of a brokerage login
   * (Plaid /investments/holdings/get + /investments/transactions/get). Optional: providers without
   * investments support leave it out.
   */
  fetchInvestments?(conn: ProviderConnection, opts: { asOf: string; startDate: string; endDate: string }): Promise<InvestStatement>;
}
