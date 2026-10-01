import {
  numberToDecimal,
  type PlaidAccount,
  PlaidApiError,
  type PlaidClient,
  type PlaidEnvironment,
  plaidInvestmentsToStatement,
  type PlaidLinkSession,
  plaidToNormalizedRows,
  type PlaidTransaction,
} from "@yomi/importers";
import {
  BankProviderError,
  type BankProvider,
  type ChangesResult,
  type ProviderAccount,
  type ProviderConnection,
  type ProviderLinkSession,
  type ProviderRow,
} from "./provider";

/** Name shown in Plaid Link ("yomi wants to connect to your bank"); Plaid allows 30 characters. */
export const PLAID_CLIENT_NAME = "yomi";

/** Error codes that Plaid resolves through Link update mode (https://plaid.com/docs/errors/). */
const RECONNECT_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "PASSWORD_RESET_REQUIRED",
  "MFA_NOT_SUPPORTED",
  "ACCESS_NOT_GRANTED",
  "INSUFFICIENT_CREDENTIALS",
  "USER_SETUP_REQUIRED",
  "ITEM_LOCKED",
  "PENDING_DISCONNECT",
  "PENDING_EXPIRATION",
]);
/** The Item no longer exists at Plaid (removed, or the token was invalidated). */
const GONE_CODES = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);

function normalizeError(e: unknown): unknown {
  if (e instanceof PlaidApiError) {
    const code = e.code ?? "";
    const reconnect = RECONNECT_CODES.has(code);
    const kind =
      reconnect ? "reconnect"
      : code === "RATE_LIMIT_EXCEEDED" || e.type === "RATE_LIMIT_EXCEEDED" ? "rate_limited"
      : e.status >= 500 || e.type === "INSTITUTION_ERROR" || e.type === "API_ERROR" ? "unavailable"
      : "other";
    const hint =
      reconnect ? " (sign in to the bank again in the Plaid window: click Reconnect)"
      : code === "INVALID_API_KEYS" ? " (check the client id and the secret for this environment in Settings > Connections > Developer keys, or PLAID_CLIENT_ID and PLAID_SECRET_SANDBOX / PLAID_SECRET_PRODUCTION)"
      : "";
    return new BankProviderError(kind, `${e.message}${hint}`, e.status, e.code);
  }
  if (e instanceof Error && !(e instanceof BankProviderError)) return new BankProviderError("unavailable", e.message);
  return e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw normalizeError(e);
  }
}

const dec = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? numberToDecimal(n) : null);

function toProviderAccount(a: PlaidAccount, institutionName: string | null): ProviderAccount {
  return {
    providerAccountId: a.account_id,
    institutionName: institutionName ?? "",
    name: a.name,
    type: a.type,
    subtype: a.subtype ?? null,
    lastFour: a.mask ?? null,
    currency: (a.balances?.iso_currency_code ?? a.balances?.unofficial_currency_code ?? "USD").toUpperCase(),
    ledgerKind: a.type === "credit" ? "credit_card" : "debit_card",
    ...(a.balances ? { balances: { current: dec(a.balances.current), available: dec(a.balances.available), limit: dec(a.balances.limit) } } : {}),
  };
}

function rowsOf(accounts: PlaidAccount[], txns: PlaidTransaction[], institutionName: string | null): ProviderRow[] {
  // The mapper skips pending rows, so pair by transaction id rather than by position.
  const accountOf = new Map(txns.map((t) => [t.transaction_id, t.account_id]));
  return plaidToNormalizedRows(accounts, txns, { institutionName }).map((row) => ({
    providerAccountId: accountOf.get(row.externalId!) ?? "",
    row,
  }));
}

/** Plaid access tokens start with access-<environment>- (https://plaid.com/docs/quickstart/glossary/). */
export function plaidTokenEnvironment(accessToken: string): string | null {
  return /^access-(sandbox|production|development)-/.exec(accessToken)?.[1] ?? null;
}

/** Public tokens from Link carry the environment the same way (public-sandbox-…). */
function publicTokenEnvironment(publicToken: string): string | null {
  return /^public-(sandbox|production|development)-/.exec(publicToken)?.[1] ?? null;
}

/** Link tokens carry the environment too (link-sandbox-…). */
export function linkTokenEnvironment(linkToken: string): string | null {
  return /^link-(sandbox|production|development)-/.exec(linkToken)?.[1] ?? null;
}

function toLinkSession(s: PlaidLinkSession): ProviderLinkSession {
  const items: ProviderLinkSession["items"] = [];
  const seen = new Set<string>();
  const push = (publicToken: string | null | undefined, institutionName: string | null | undefined) => {
    if (!publicToken || seen.has(publicToken)) return;
    seen.add(publicToken);
    items.push({ publicToken, institutionName: institutionName ?? null });
  };
  for (const r of s.results?.item_add_results ?? []) push(r.public_token, r.institution?.name);
  push(s.on_success?.public_token, s.on_success?.metadata?.institution?.name);
  const exitStatus = s.exit?.metadata?.status ?? s.exit?.exit_status ?? s.on_exit?.metadata?.status ?? null;
  return {
    linkSessionId: s.link_session_id,
    finished: Boolean(s.finished_at || s.on_success || s.on_exit || s.exit),
    exitStatus,
    items,
  };
}

/**
 * One provider over a Plaid client per configured environment (the client_id is shared, each
 * environment has its own secret). Existing connections route by their token's environment.
 */
export function createPlaidProvider(
  clients: Partial<Record<PlaidEnvironment, PlaidClient>>,
  opts: { defaultEnvironment?: PlaidEnvironment } = {},
): BankProvider {
  const environments = (["production", "sandbox"] as const).filter((e) => clients[e]);
  if (environments.length === 0) throw new Error("createPlaidProvider: no Plaid client");
  const defaultEnvironment = opts.defaultEnvironment && clients[opts.defaultEnvironment] ? opts.defaultEnvironment : environments[0]!;

  function clientFor(env: string | null | undefined): PlaidClient {
    const c = clients[(env ?? defaultEnvironment) as PlaidEnvironment];
    if (!c) throw new BankProviderError("other", `No Plaid secret configured for the ${env} environment (PLAID_SECRET_${String(env).toUpperCase()})`);
    return c;
  }
  const clientOf = (conn: ProviderConnection) => clientFor(plaidTokenEnvironment(conn.accessToken));

  return {
    id: "plaid",
    source: "plaid",
    environments: [...environments],
    defaultEnvironment,
    tokenEnvironment: plaidTokenEnvironment,
    createLinkToken: ({ clientUserId, accessToken, environment, kind }) =>
      guarded(async () => {
        const client = clientFor(accessToken ? (plaidTokenEnvironment(accessToken) ?? environment) : environment);
        const products = kind === "brokerage" ? (["investments"] as const) : (["transactions"] as const);
        const r = await client.linkTokenCreate({ clientUserId, clientName: PLAID_CLIENT_NAME, accessToken, products: [...products] });
        return { linkToken: r.link_token, expiration: r.expiration };
      }),
    getLinkSessions: (linkToken, o) =>
      guarded(async () => {
        const r = await clientFor(o?.environment ?? linkTokenEnvironment(linkToken)).linkTokenGet(linkToken);
        return (r.link_sessions ?? []).map(toLinkSession);
      }),
    exchangePublicToken: (publicToken, o) =>
      guarded(async () => {
        const r = await clientFor(o?.environment ?? publicTokenEnvironment(publicToken)).publicTokenExchange(publicToken);
        return { accessToken: r.access_token, enrollmentId: r.item_id };
      }),
    listAccounts: (conn: ProviderConnection) =>
      guarded(async () => {
        const r = await clientOf(conn).accountsGet(conn.accessToken);
        const inst = conn.institutionName ?? r.item?.institution_name ?? null;
        return r.accounts.map((a) => toProviderAccount(a, inst));
      }),
    fetchChanges: (conn, cursor): Promise<ChangesResult> =>
      guarded(async () => {
        const client = clientOf(conn);
        const r = await client.transactionsSync(conn.accessToken, cursor);
        let plaidAccounts = r.accounts;
        if (plaidAccounts.length === 0 && (r.added.length || r.modified.length)) {
          plaidAccounts = (await client.accountsGet(conn.accessToken)).accounts;
        }
        const inst = conn.institutionName;
        return {
          added: rowsOf(plaidAccounts, r.added, inst),
          modified: rowsOf(plaidAccounts, r.modified, inst),
          removed: r.removed.map((x) => ({ providerAccountId: x.account_id ?? null, externalId: x.transaction_id })),
          accounts: plaidAccounts.length ? plaidAccounts.map((a) => toProviderAccount(a, inst)) : null,
          nextCursor: r.nextCursor,
        };
      }),
    fetchInvestments: (conn, o) =>
      guarded(async () => {
        const client = clientOf(conn);
        const holdings = await client.investmentsHoldingsGet(conn.accessToken);
        let txns = null;
        try {
          const t = await client.investmentsTransactionsGet(conn.accessToken, o.startDate, o.endDate);
          txns = { transactions: t.transactions, securities: t.securities };
        } catch (e) {
          // Right after Link the transactions pull may still be running; holdings are enough for today.
          if (!(e instanceof PlaidApiError && e.code === "PRODUCT_NOT_READY")) throw e;
        }
        const institutionName = conn.institutionName ?? holdings.item?.institution_name ?? null;
        return plaidInvestmentsToStatement(holdings, txns, { asOf: o.asOf, institutionName });
      }),
    disconnect: (conn) =>
      guarded(async () => {
        try {
          await clientOf(conn).itemRemove(conn.accessToken);
        } catch (e) {
          // Already removed or unknown to Plaid: nothing left to revoke.
          if (e instanceof PlaidApiError && GONE_CODES.has(e.code ?? "")) return;
          throw e;
        }
      }),
  };
}
