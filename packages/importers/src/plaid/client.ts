import type {
  PlaidAccountsGetResponse,
  PlaidEnvironment,
  PlaidErrorBody,
  PlaidRemovedTransaction,
  PlaidTransaction,
  PlaidTransactionsSyncPage,
  PlaidAccount,
  PlaidLinkTokenGetResponse,
  PlaidInvestmentsHoldingsResponse,
  PlaidInvestmentsTransactionsResponse,
  PlaidInvestmentTransaction,
  PlaidSecurity,
} from "./types";

export const PLAID_BASE_URLS: Record<PlaidEnvironment, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export interface PlaidClientOptions {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
  /** Defaults to the global fetch (Node built-in). Tests inject a fake; no network in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Non-2xx answer from Plaid. `code` is the API's error_code, e.g. ITEM_LOGIN_REQUIRED. */
export class PlaidApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
    message: string,
    readonly displayMessage: string | null = null,
  ) {
    super(message);
    this.name = "PlaidApiError";
  }
}

export interface LinkTokenCreateInput {
  clientUserId: string;
  clientName: string;
  /** Set for update mode (re-login of an existing Item); products are then omitted, as the docs require. */
  accessToken?: string;
  language?: string;
  /** History to request when the Item is created (1 to 730 days, Plaid default 90). */
  daysRequested?: number;
  /**
   * Products for a new Item: ["transactions"] (default, bank connections) or ["investments"]
   * (brokerage connections). Ignored in update mode.
   */
  products?: ("transactions" | "investments")[];
}

export interface InvestmentsTransactionsResult {
  transactions: PlaidInvestmentTransaction[];
  securities: PlaidSecurity[];
  total: number;
}

export interface TransactionsSyncResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  accounts: PlaidAccount[];
  /** Cursor to store for the next call. Null while Plaid has no data for the Item yet (empty string). */
  nextCursor: string | null;
  updateStatus: string | null;
}

export interface PlaidClient {
  linkTokenCreate(input: LinkTokenCreateInput): Promise<{ link_token: string; expiration: string }>;
  /** Sessions opened with this link token and what they produced (session data kept 6 h after a session ends). */
  linkTokenGet(linkToken: string): Promise<PlaidLinkTokenGetResponse>;
  publicTokenExchange(publicToken: string): Promise<{ access_token: string; item_id: string }>;
  accountsGet(accessToken: string): Promise<PlaidAccountsGetResponse>;
  /** Follows has_more until the end; restarts from `cursor` on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION. */
  transactionsSync(accessToken: string, cursor: string | null, opts?: { count?: number; maxPages?: number }): Promise<TransactionsSyncResult>;
  itemRemove(accessToken: string): Promise<void>;
  investmentsHoldingsGet(accessToken: string): Promise<PlaidInvestmentsHoldingsResponse>;
  /** Every investment transaction in [startDate, endDate] (YYYY-MM-DD), following count/offset pages. */
  investmentsTransactionsGet(accessToken: string, startDate: string, endDate: string, opts?: { count?: number; maxPages?: number }): Promise<InvestmentsTransactionsResult>;
}

const MUTATION_RETRIES = 3;

export function createPlaidClient(opts: PlaidClientOptions): PlaidClient {
  const base = PLAID_BASE_URLS[opts.environment];
  const doFetch = opts.fetch ?? fetch;

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Auth: client_id + secret in the JSON body (https://plaid.com/docs/api/).
      body: JSON.stringify({ client_id: opts.clientId, secret: opts.secret, ...body }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let e: Partial<PlaidErrorBody> = {};
      try {
        e = JSON.parse(text) as Partial<PlaidErrorBody>;
      } catch {
        // non-JSON error body
      }
      const detail = e.error_code ? `${e.error_code}: ${e.display_message ?? e.error_message ?? ""}` : `HTTP ${res.status}`;
      throw new PlaidApiError(res.status, e.error_type ?? null, e.error_code ?? null, `Plaid ${path} failed: ${detail}`, e.display_message ?? null);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    linkTokenCreate: (i) =>
      call("/link/token/create", {
        client_name: i.clientName,
        language: i.language ?? "en",
        country_codes: ["US"],
        user: { client_user_id: i.clientUserId },
        ...(i.accessToken ? { access_token: i.accessToken }
        : (i.products ?? ["transactions"]).includes("transactions") ?
          { products: i.products ?? ["transactions"], transactions: { days_requested: i.daysRequested ?? 730 } }
        : { products: i.products }),
      }),
    linkTokenGet: (linkToken) => call("/link/token/get", { link_token: linkToken }),
    publicTokenExchange: (publicToken) => call("/item/public_token/exchange", { public_token: publicToken }),
    accountsGet: (accessToken) => call("/accounts/get", { access_token: accessToken }),
    async transactionsSync(accessToken, cursor, o = {}) {
      const maxPages = o.maxPages ?? 500;
      for (let attempt = 0; ; attempt++) {
        const out: TransactionsSyncResult = { added: [], modified: [], removed: [], accounts: [], nextCursor: cursor, updateStatus: null };
        let cur = cursor;
        try {
          for (let page = 0; page < maxPages; page++) {
            const p = await call<PlaidTransactionsSyncPage>("/transactions/sync", {
              access_token: accessToken,
              ...(cur ? { cursor: cur } : {}),
              count: o.count ?? 500,
            });
            out.added.push(...p.added);
            out.modified.push(...p.modified);
            out.removed.push(...p.removed);
            if (p.accounts?.length) out.accounts = p.accounts;
            out.updateStatus = p.transactions_update_status ?? null;
            cur = p.next_cursor || null;
            out.nextCursor = cur ?? cursor;
            if (!p.has_more) return out;
          }
          throw new Error(`Plaid /transactions/sync did not finish within ${maxPages} pages`);
        } catch (e) {
          // The docs: restart the whole loop from the first cursor, not just the failed page.
          if (e instanceof PlaidApiError && e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < MUTATION_RETRIES) continue;
          throw e;
        }
      }
    },
    async itemRemove(accessToken) {
      await call("/item/remove", { access_token: accessToken });
    },
    investmentsHoldingsGet: (accessToken) => call("/investments/holdings/get", { access_token: accessToken }),
    async investmentsTransactionsGet(accessToken, startDate, endDate, o = {}) {
      // count max 500; paginate with offset until total_investment_transactions is reached.
      const count = Math.min(o.count ?? 500, 500);
      const out: InvestmentsTransactionsResult = { transactions: [], securities: [], total: 0 };
      const secs = new Map<string, PlaidSecurity>();
      for (let page = 0; page < (o.maxPages ?? 200); page++) {
        const p = await call<PlaidInvestmentsTransactionsResponse>("/investments/transactions/get", {
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count, offset: out.transactions.length },
        });
        out.transactions.push(...p.investment_transactions);
        for (const s of p.securities ?? []) secs.set(s.security_id, s);
        out.total = p.total_investment_transactions;
        if (p.investment_transactions.length === 0 || out.transactions.length >= out.total) {
          out.securities = [...secs.values()];
          return out;
        }
      }
      throw new Error(`Plaid /investments/transactions/get did not finish within ${o.maxPages ?? 200} pages`);
    },
  };
}

/**
 * Checks a client id and secret against one environment with a harmless read (`/institutions/get`, count 1):
 * nothing is created and no Item is used. Resolves when Plaid accepts the keys; throws PlaidApiError
 * (e.g. INVALID_API_KEYS) or the fetch error otherwise.
 */
export async function checkPlaidKeys(opts: PlaidClientOptions): Promise<void> {
  const res = await (opts.fetch ?? fetch)(`${PLAID_BASE_URLS[opts.environment]}/institutions/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: opts.clientId, secret: opts.secret, count: 1, offset: 0, country_codes: ["US"] }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (res.ok) return;
  const text = await res.text();
  let e: Partial<PlaidErrorBody> = {};
  try {
    e = JSON.parse(text) as Partial<PlaidErrorBody>;
  } catch {
    // non-JSON error body
  }
  const detail = e.error_code ? `${e.error_code}: ${e.error_message ?? ""}` : `HTTP ${res.status}`;
  throw new PlaidApiError(res.status, e.error_type ?? null, e.error_code ?? null, `Plaid /institutions/get failed: ${detail}`, e.display_message ?? null);
}
