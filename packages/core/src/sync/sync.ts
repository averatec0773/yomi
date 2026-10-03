import { accounts, bankAccounts, bankConnections, type Db, transactions } from "@yomi/db";
import { CodedError, type MessageParams, type NormalizedRow, type Notice, notice, type ParseResult } from "@yomi/importers";
import { and, asc, eq, inArray, isNull } from "@yomi/db/orm";
import type { AccountSpec } from "../import/accounts";
import { sha256Hex } from "../import/dedup";
import { cleanMerchant } from "../import/merchant";
import { type LockReason, lockReason } from "../ledger/lock";
import { commitParsed } from "../import/pipeline";
import { openSecret, sealSecret, tryOpenSecret } from "../secrets/crypto";
import { assertSecretsUsable } from "../secrets/tokens";
import { getTimeZone } from "../settings/time-zone";
import { occurredOnFor, todayIn } from "../time/zone";
import { recordProviderBalances } from "../assets/balances";
import type { CurrentUser } from "../user";
import { getLinkSession, markExchanged, parseExchanged, publicTokenHash, recordLinkSession } from "./link-session-store";
import { BankProviderError, type BankProvider, type ConnectionKind, type ProviderAccount, type ProviderConnection, type ProviderRow } from "./provider";

export type BankSyncErrorKind =
  | "connection_not_found"
  | "connection_disconnected"
  | "connection_paused"
  | "wrong_provider"
  | "wrong_environment"
  | "connection_is_brokerage";

export class BankSyncError extends CodedError {
  constructor(
    readonly kind: BankSyncErrorKind,
    code: string,
    message: string,
    params: MessageParams = {},
  ) {
    super(code, message, params);
    this.name = "BankSyncError";
  }
}

export interface EnrollmentInput {
  accessToken: string;
  enrollmentId: string;
  institutionName: string | null;
  /** Default bank. A brokerage login keeps no ledger account mapping and never runs transactions sync. */
  kind?: ConnectionKind;
}

export interface BankAccountSummary {
  id: number;
  accountId: number;
  name: string;
  type: string;
  subtype: string | null;
  lastFour: string | null;
  currency: string;
}

export interface BankConnectionSummary {
  id: number;
  provider: "plaid";
  kind: ConnectionKind;
  /** Environment the stored token belongs to (sandbox | production), null when unknown. */
  environment: string | null;
  institutionName: string | null;
  status: "active" | "paused" | "disconnected" | "error";
  lastError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  accounts: BankAccountSummary[];
}

export interface SyncResult {
  connectionId: number;
  /** Null when nothing was new (no batch is written for an empty sync). */
  batchId: number | null;
  fetched: number;
  inserted: number;
  skippedDup: number;
  linked: number;
  autoSplit: number;
  /** Stored rows updated because the provider changed them. */
  modified: number;
  /** Stored rows deleted because the provider removed them. */
  removed: number;
  warnings: Notice[];
}

type Q = Db;

/** How a lock reason reads in a notice (param `reason` carries the code). */
const LOCK_WORDS: Record<LockReason, string> = { edited: "edited by hand", split: "split", settled: "recorded as a settlement" };
type ConnRow = typeof bankConnections.$inferSelect;

function ledgerSpec(a: ProviderAccount): AccountSpec {
  const inst = a.institutionName || null;
  return {
    name: [inst, a.name, a.lastFour].filter(Boolean).join(" "),
    kind: a.ledgerKind,
    institution: inst,
    last4: a.lastFour,
    currency: a.currency,
  };
}

/** The connection with its access token decrypted; throws SecretKeyError (before any write) when it cannot be. */
function providerConn(c: ConnRow): ProviderConnection {
  return { accessToken: openSecret(c.accessToken), enrollmentId: c.enrollmentId, institutionName: c.institutionName };
}

async function getConnection(db: Db, user: CurrentUser, id: number): Promise<ConnRow> {
  const c = (await db
    .select()
    .from(bankConnections)
    .where(and(eq(bankConnections.userId, user.id), eq(bankConnections.id, id)))
    .limit(1))[0];
  if (!c) throw new BankSyncError("connection_not_found", "bank_connection_not_found", `Bank connection #${id} does not exist`, { id });
  return c;
}

/** Ledger account for a provider account: an existing one with the same kind + institution + last four, else a new one. */
async function ensureLedgerAccount(db: Q, user: CurrentUser, spec: AccountSpec): Promise<number> {
  const match = (await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, user.id),
        eq(accounts.kind, spec.kind),
        spec.institution == null ? isNull(accounts.institution) : eq(accounts.institution, spec.institution),
        spec.last4 == null ? isNull(accounts.last4) : eq(accounts.last4, spec.last4),
      ),
    )
    .orderBy(asc(accounts.id))
    .limit(1))[0];
  if (match) return match.id;
  return (await db
    .insert(accounts)
    .values({ userId: user.id, ...spec })
    .returning({ id: accounts.id })
    )[0]!.id;
}

async function upsertBankAccounts(tx: Q, user: CurrentUser, connId: number, providerAccounts: readonly ProviderAccount[]): Promise<void> {
  for (const a of providerAccounts) {
    const accountId = await ensureLedgerAccount(tx, user, ledgerSpec(a));
    await tx.insert(bankAccounts)
      .values({
        userId: user.id,
        connectionId: connId,
        providerAccountId: a.providerAccountId,
        accountId,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        lastFour: a.lastFour,
        currency: a.currency,
      })
      .onConflictDoUpdate({
        target: [bankAccounts.connectionId, bankAccounts.providerAccountId],
        set: { name: a.name, type: a.type, subtype: a.subtype, lastFour: a.lastFour, currency: a.currency, accountId },
      });
  }
}

/**
 * Stores a new login in two steps. First the connection row with the access token, in its own
 * write, so a later failure can never lose the login (on Plaid's Trial plan a lost Item is a lost
 * slot). Then its accounts are fetched and mapped to ledger accounts; if that fails the connection
 * stays, marked `error`, and a normal sync or reconnect picks it up. Transactions are fetched by
 * syncConnection.
 */
export async function saveEnrollment(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  input: EnrollmentInput,
): Promise<BankConnectionSummary> {
  const connId = await storeConnection(db, user, provider, input);
  // Investment accounts are created by the holdings sync (core/invest), not as ledger accounts.
  if (input.kind === "brokerage") return await getConnectionSummary(db, user, connId, provider);
  try {
    const providerAccounts = await provider.listAccounts({ ...input });
    const institutionName = input.institutionName ?? (providerAccounts[0]?.institutionName || null);
    await db.transaction(async (tx) => {
      if (institutionName !== input.institutionName) {
        await tx.update(bankConnections).set({ institutionName }).where(eq(bankConnections.id, connId));
      }
      await upsertBankAccounts(tx, user, connId, providerAccounts);
    });
  } catch (e) {
    await recordError(db, connId, e);
  }
  return await getConnectionSummary(db, user, connId, provider);
}

/** Inserts (or reactivates, for the same Item) the connection row with its access token. */
async function storeConnection(db: Db, user: CurrentUser, provider: BankProvider, input: EnrollmentInput): Promise<number> {
  return await db.transaction(async (tx) => {
    const existing = (await tx
      .select({ id: bankConnections.id })
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.userId, user.id),
          eq(bankConnections.provider, provider.id),
          eq(bankConnections.enrollmentId, input.enrollmentId),
        ),
      )
      .limit(1))[0];
    if (existing) {
      await tx.update(bankConnections)
        .set({ accessToken: sealSecret(input.accessToken), institutionName: input.institutionName, status: "active", lastError: null, kind: input.kind ?? "bank" })
        .where(eq(bankConnections.id, existing.id));
      return existing.id;
    }
    return (await tx
      .insert(bankConnections)
      .values({
        userId: user.id,
        provider: provider.id,
        enrollmentId: input.enrollmentId,
        institutionName: input.institutionName,
        accessToken: sealSecret(input.accessToken),
        status: "active",
        kind: input.kind ?? "bank",
      })
      .returning({ id: bankConnections.id })
      )[0]!.id;
  });
}

/** Public tokens live 30 minutes at Plaid; a retried exchange within that window reuses the stored connection. */
const EXCHANGE_REUSE_MS = 30 * 60 * 1000;
type ExchangeLog = Map<string, { connectionId: number; at: number }>;
/** Per database: sha256(public token) → connection it created. Process memory, kept across hot reloads via globalThis. */
const exchangeLogs = ((globalThis as unknown as { yomiPlaidExchanged?: WeakMap<Db, ExchangeLog> }).yomiPlaidExchanged ??= new WeakMap());

/**
 * Link's onSuccess: trades the public token for an access token and stores the login. Idempotent
 * for retries: the same public token posted again within 30 minutes returns the connection it
 * already created (`reused: true`) without calling the provider again.
 */
export async function connectWithPublicToken(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  input: { publicToken: string; institutionName: string | null; environment?: string; linkSessionId?: number; kind?: ConnectionKind },
  now: () => number = Date.now,
): Promise<BankConnectionSummary & { reused: boolean }> {
  let exchanged = exchangeLogs.get(db);
  if (!exchanged) exchangeLogs.set(db, (exchanged = new Map()));
  const key = `${user.id}:${sha256Hex(input.publicToken)}`;
  for (const [k, v] of exchanged) if (now() - v.at >= EXCHANGE_REUSE_MS) exchanged.delete(k);
  const prior = exchanged.get(key);
  if (prior) {
    const conn = (await listConnections(db, user, provider)).find((c) => c.id === prior.connectionId);
    if (conn && conn.status !== "disconnected") return { ...conn, reused: true };
  }
  // Server-side recovery may have saved this Item already (Plaid lists it before Link's last pane).
  if (input.linkSessionId != null) {
    const s = await getLinkSession(db, user, input.linkSessionId);
    const h = publicTokenHash(input.publicToken);
    if (s?.connectionId != null && parseExchanged(s.exchanged).some((e) => e.h === h)) {
      const conn = (await listConnections(db, user, provider)).find((c) => c.id === s.connectionId);
      if (conn && conn.status !== "disconnected") return { ...conn, reused: true };
    }
  }
  if (input.environment && !provider.environments.includes(input.environment)) {
    throw environmentUnavailable(input.environment, "new");
  }
  // Before the exchange: an access token Plaid hands out must be storable (on Trial a lost Item is a lost slot).
  await assertSecretsUsable(db);
  const { accessToken, enrollmentId } = await provider.exchangePublicToken(input.publicToken, { environment: input.environment });
  // The Link session records what the login was opened for; it wins over what the browser says.
  const kind = (input.linkSessionId != null ? (await getLinkSession(db, user, input.linkSessionId))?.kind : undefined) ?? input.kind ?? "bank";
  const enrollment = { accessToken, enrollmentId, institutionName: input.institutionName, kind };
  const connectionId = await storeConnection(db, user, provider, enrollment);
  exchanged.set(key, { connectionId, at: now() });
  if (input.linkSessionId != null) await markExchanged(db, user, input.linkSessionId, input.publicToken, "callback", connectionId);
  return { ...(await saveEnrollment(db, user, provider, enrollment)), reused: false };
}

/**
 * Link token for a new login, or (with connectionId) for update mode on an existing one. The token
 * is persisted (plaid_link_sessions) before it is returned, so whatever Plaid creates in that Link
 * session can be recovered server side; `sessionId` is that row.
 */
export async function createLinkToken(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  opts: { connectionId?: number; environment?: string; kind?: ConnectionKind } = {},
): Promise<{ linkToken: string; expiration: string; sessionId: number }> {
  await assertSecretsUsable(db);
  if (opts.connectionId != null) {
    const conn = await getConnection(db, user, opts.connectionId);
    if (conn.status === "disconnected") throw disconnected();
    const accessToken = openSecret(conn.accessToken);
    assertEnvironmentAvailable(provider, accessToken);
    const environment = provider.tokenEnvironment(accessToken) ?? undefined;
    const r = await provider.createLinkToken({ clientUserId: String(user.id), accessToken, environment, kind: conn.kind });
    const sessionId = await recordLinkSession(db, user, {
      linkToken: r.linkToken,
      environment: environment ?? provider.defaultEnvironment,
      purpose: "update",
      kind: conn.kind,
      connectionId: conn.id,
    });
    return { ...r, sessionId };
  }
  const environment = opts.environment ?? provider.defaultEnvironment;
  if (!provider.environments.includes(environment)) throw environmentUnavailable(environment, "new");
  const kind = opts.kind ?? "bank";
  const r = await provider.createLinkToken({ clientUserId: String(user.id), environment, kind });
  return { ...r, sessionId: await recordLinkSession(db, user, { linkToken: r.linkToken, environment, purpose: "new", kind }) };
}

export async function listConnections(db: Db, user: CurrentUser, provider?: Pick<BankProvider, "tokenEnvironment"> | null): Promise<BankConnectionSummary[]> {
  const conns = await db
    .select()
    .from(bankConnections)
    .where(eq(bankConnections.userId, user.id))
    .orderBy(asc(bankConnections.id));
  if (conns.length === 0) return [];
  const accts = await db
    .select()
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.userId, user.id),
        inArray(
          bankAccounts.connectionId,
          conns.map((c) => c.id),
        ),
      ),
    )
    .orderBy(asc(bankAccounts.id));
  const envOf = provider?.tokenEnvironment ?? tokenEnvironmentFallback;
  return conns.map((c) => ({
    id: c.id,
    provider: c.provider,
    kind: c.kind,
    environment: tokenEnv(envOf, c.accessToken),
    institutionName: c.institutionName,
    status: c.status,
    lastError: c.lastError,
    lastSyncedAt: c.lastSyncedAt,
    createdAt: c.createdAt,
    accounts: accts
      .filter((a) => a.connectionId === c.id)
      .map((a) => ({
        id: a.id,
        accountId: a.accountId,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        lastFour: a.lastFour,
        currency: a.currency,
      })),
  }));
}

/** Environment of a stored (possibly encrypted) token, null when empty or it cannot be decrypted. */
function tokenEnv(envOf: (token: string) => string | null, stored: string): string | null {
  const token = stored ? tryOpenSecret(stored) : null;
  return token ? envOf(token) : null;
}

/** Plaid token format `[type]-[environment]-[uuid]`; used when no provider is configured. */
function tokenEnvironmentFallback(token: string): string | null {
  return /^[a-z]+-(sandbox|production|development)-/.exec(token)?.[1] ?? null;
}

export async function getConnectionSummary(db: Db, user: CurrentUser, id: number, provider?: BankProvider | null): Promise<BankConnectionSummary> {
  const s = (await listConnections(db, user, provider)).find((c) => c.id === id);
  if (!s) throw new BankSyncError("connection_not_found", "bank_connection_not_found", `Bank connection #${id} does not exist`, { id });
  return s;
}

async function recordError(db: Db, id: number, e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  await db.update(bankConnections).set({ status: "error", lastError: message }).where(eq(bankConnections.id, id));
}

const ENV_NAME: Record<string, string> = { sandbox: "Sandbox", production: "Production", development: "Development" };

/**
 * Whether the provider holds credentials for the environment of this token (unknown token formats
 * pass, and so does a stored token that cannot be decrypted: its sync then reports the key error).
 */
function supportsToken(provider: BankProvider, storedOrPlain: string): boolean {
  const env = tokenEnv((t) => provider.tokenEnvironment(t), storedOrPlain);
  return env == null || provider.environments.includes(env);
}

/** `what`: a new login ("new") or an existing connection's token ("connection"). */
function environmentUnavailable(env: string, what: "new" | "connection"): BankSyncError {
  const environment = ENV_NAME[env] ?? env;
  const secretVar = `PLAID_SECRET_${env.toUpperCase()}`;
  const subject = what === "new" ? "The bank to connect" : "This connection";
  return new BankSyncError(
    "wrong_environment",
    what === "new" ? "bank_environment_unavailable_new" : "bank_environment_unavailable_connection",
    `${subject} is in the ${environment} environment, but ${secretVar} is not configured`,
    { environment, secretVar },
  );
}

function disconnected(): BankSyncError {
  return new BankSyncError("connection_disconnected", "bank_connection_disconnected", "This bank connection is disconnected; connect the bank again");
}

function assertEnvironmentAvailable(provider: BankProvider, accessToken: string): void {
  if (!supportsToken(provider, accessToken)) throw environmentUnavailable(provider.tokenEnvironment(accessToken)!, "connection");
}

async function findStored(q: Q, userId: number, source: string, externalId: string) {
  return (await q
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.source, source as "plaid"), eq(transactions.sourceRef, externalId)))
    .limit(1))[0];
}

function describeRow(r: { occurredAt: string; amountMinor: number; currency: string; merchant?: string; counterpartyRaw?: string }): string {
  return `${r.occurredAt.slice(0, 10)} ${r.merchant || r.counterpartyRaw || ""} ${(r.amountMinor / 100).toFixed(2)} ${r.currency}`.replace(/\s+/g, " ");
}

/**
 * Fetches the connection's changes since its cursor (Plaid: one cursor per Item) and applies them:
 * - added rows (and modified rows not stored yet) go through the regular import pipeline as one
 *   batch: dedup by `<source>:<transaction id>`, merchant cleanup, categories, auto-split rules,
 *   linking card rows to the Alipay/WeChat row paid with that card. No batch when nothing is new.
 * - modified rows update amount, date and merchant of the stored row, unless I edited, split or
 *   settled it (then a warning).
 * - removed rows delete the stored row under the same condition.
 * The cursor moves only after all of that is written, so a crash in between just replays changes
 * that are idempotent. A provider failure marks the connection `error` and is rethrown.
 */
export async function syncConnection(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  connectionId: number,
  opts: { backup?: boolean; now?: () => Date } = {},
): Promise<SyncResult> {
  const conn = await getConnection(db, user, connectionId);
  if (conn.status === "disconnected") throw disconnected();
  if (conn.status === "paused") throw new BankSyncError("connection_paused", "bank_connection_paused", "Syncing is paused for this bank connection; resume it first");
  if (conn.provider !== provider.id) throw new BankSyncError("wrong_provider", "bank_wrong_provider", `Connection #${conn.id} belongs to ${conn.provider}`, {
      id: conn.id,
      provider: conn.provider,
    });
  if (conn.kind === "brokerage") {
    throw new BankSyncError("connection_is_brokerage", "bank_connection_is_brokerage", `Connection #${conn.id} is a brokerage login; it syncs holdings, not transactions`, {
      id: conn.id,
    });
  }
  // Decrypted before the try below: a missing or wrong key must not mark the connection `error`.
  const pc = providerConn(conn);
  assertEnvironmentAvailable(provider, pc.accessToken);

  let changes;
  try {
    changes = await provider.fetchChanges(pc, conn.cursor);
  } catch (e) {
    await recordError(db, conn.id, e);
    throw e;
  }

  if (changes.accounts?.length) {
    const known = new Set(
      (await db
        .select({ id: bankAccounts.providerAccountId })
        .from(bankAccounts)
        .where(eq(bankAccounts.connectionId, conn.id))
        )
        .map((r) => r.id),
    );
    const fresh = changes.accounts.filter((a) => !known.has(a.providerAccountId));
    if (fresh.length) await db.transaction(async (tx) => await upsertBankAccounts(tx, user, conn.id, fresh));
  }

  const specByAccount = new Map<string, AccountSpec>();
  for (const b of (await db
    .select({ providerAccountId: bankAccounts.providerAccountId, ledger: accounts })
    .from(bankAccounts)
    .innerJoin(accounts, eq(accounts.id, bankAccounts.accountId))
    .where(and(eq(bankAccounts.userId, user.id), eq(bankAccounts.connectionId, conn.id)))
    )) {
    const l = b.ledger;
    specByAccount.set(b.providerAccountId, {
      name: l.name,
      kind: l.kind as AccountSpec["kind"],
      institution: l.institution,
      last4: l.last4,
      currency: l.currency,
    });
  }

  const source = provider.source;
  const toAdd: ProviderRow[] = [...changes.added];
  const toModify: ProviderRow[] = [];
  for (const m of changes.modified) {
    if ((await findStored(db, user.id, source, m.row.externalId!))) toModify.push(m);
    else toAdd.push(m);
  }

  const rows: NormalizedRow[] = [];
  const specByRow = new Map<NormalizedRow, AccountSpec>();
  for (const a of toAdd) {
    const r = { ...a.row, lineNo: rows.length + 1 };
    rows.push(r);
    const spec = specByAccount.get(a.providerAccountId);
    if (spec) specByRow.set(r, spec);
  }

  const now = (opts.now ?? (() => new Date()))().toISOString();
  const parsed: ParseResult = { source, rows, declared: {}, warnings: [] };
  const label = `${conn.institutionName ?? provider.id} sync ${now.slice(0, 10)}`;
  const result = rows.length
    ? await commitParsed(db, user, parsed, {
        fileHash: sha256Hex(`bank-sync:${conn.id}:${now}`),
        fileName: label,
        force: true,
        backup: opts.backup,
        noDeclared: true,
        skipIfNothingNew: true,
        by: `sync:${conn.id}`,
        accountSpec: (r) => specByRow.get(r) ?? null,
      })
    : null;

  const warnings = [...(result?.warnings ?? [])];
  let modified = 0;
  let removed = 0;
  await db.transaction(async (tx) => {
    for (const m of toModify) {
      const stored = await findStored(tx, user.id, source, m.row.externalId!);
      if (!stored) continue;
      const r = m.row;
      const merchant = cleanMerchant(r.counterparty);
      const same =
        stored.amountMinor === r.amountMinor &&
        stored.currency === r.currency &&
        stored.occurredAt === r.occurredAt &&
        stored.counterpartyRaw === r.counterparty &&
        stored.merchant === merchant;
      if (same) continue;
      const why = await lockReason(tx, user.id, stored);
      if (why) {
        const before = describeRow(stored);
        const after = describeRow({ ...r, merchant });
        warnings.push(
          notice(
            "sync_modified_locked",
            `The bank changed transaction #${stored.id} (${before} → ${after}), but it is ${LOCK_WORDS[why]}, so it was not updated; please check it`,
            { id: stored.id, before, after, reason: why },
          ),
        );
        continue;
      }
      await tx.update(transactions)
        .set({
          amountMinor: r.amountMinor,
          currency: r.currency,
          occurredAt: r.occurredAt,
          occurredOn: occurredOnFor(r.occurredAt, source, await getTimeZone(tx, user)),
          counterpartyRaw: r.counterparty,
          descriptionRaw: r.description,
          merchant,
          sourceCategory: r.sourceCategory,
          raw: r.raw,
        })
        .where(eq(transactions.id, stored.id));
      modified += 1;
    }
    for (const x of changes.removed) {
      const stored = await findStored(tx, user.id, source, x.externalId);
      if (!stored) continue; // a pending row we never stored
      const why = await lockReason(tx, user.id, stored);
      if (why) {
        const row = describeRow(stored);
        warnings.push(
          notice(
            "sync_removed_locked",
            `The bank removed transaction #${stored.id} (${row}), but it is ${LOCK_WORDS[why]}, so it was kept; please check it`,
            { id: stored.id, row, reason: why },
          ),
        );
        continue;
      }
      await tx.update(transactions)
        .set({ duplicateOfId: null })
        .where(and(eq(transactions.userId, user.id), eq(transactions.duplicateOfId, stored.id)));
      await tx.delete(transactions).where(eq(transactions.id, stored.id));
      removed += 1;
    }
    // Today's balance of each account, as the bank reports it (Assets history).
    if (changes.accounts?.length) await recordProviderBalances(tx, user, conn.id, changes.accounts, todayIn(await getTimeZone(tx, user), opts.now ? new Date(now) : undefined));
    await tx.update(bankConnections)
      .set({ cursor: changes.nextCursor, lastSyncedAt: now, status: "active", lastError: null })
      .where(eq(bankConnections.id, conn.id));
  });

  return {
    connectionId: conn.id,
    batchId: result?.batchId ?? null,
    fetched: rows.length,
    inserted: result?.inserted ?? 0,
    skippedDup: result ? result.skippedDup : rows.length,
    linked: result?.linked ?? 0,
    autoSplit: result?.autoSplit ?? 0,
    modified,
    removed,
    warnings,
  };
}

export interface SyncAllResult {
  results: SyncResult[];
  errors: { connectionId: number; message: string }[];
}

/**
 * Syncs every connection of this provider that is neither disconnected nor paused and whose environment has a
 * secret configured (a sandbox login is skipped without PLAID_SECRET_SANDBOX); one failure does not stop the rest.
 */
export async function syncAll(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  opts: { backup?: boolean; now?: () => Date } = {},
): Promise<SyncAllResult> {
  const conns = (await db
    .select({ id: bankConnections.id, status: bankConnections.status, accessToken: bankConnections.accessToken })
    .from(bankConnections)
    .where(and(eq(bankConnections.userId, user.id), eq(bankConnections.provider, provider.id), eq(bankConnections.kind, "bank")))
    .orderBy(asc(bankConnections.id))
    )
    .filter((c) => c.status !== "disconnected" && c.status !== "paused")
    .filter((c) => supportsToken(provider, c.accessToken));
  const out: SyncAllResult = { results: [], errors: [] };
  for (const c of conns) {
    try {
      out.results.push(await syncConnection(db, user, provider, c.id, opts));
    } catch (e) {
      out.errors.push({ connectionId: c.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * Syncs the active connections that never received data (cursor still null): right after a login,
 * Plaid often answers /transactions/sync with nothing until the Item's first pull is ready. Called
 * on every scheduler tick so a fresh connection fills within minutes, not at the next 6-hour run.
 */
export async function syncAwaitingFirstData(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  opts: { backup?: boolean; now?: () => Date } = {},
): Promise<SyncAllResult> {
  const conns = (await db
    .select({ id: bankConnections.id, status: bankConnections.status, accessToken: bankConnections.accessToken, cursor: bankConnections.cursor })
    .from(bankConnections)
    .where(
      and(
        eq(bankConnections.userId, user.id),
        eq(bankConnections.provider, provider.id),
        eq(bankConnections.kind, "bank"),
        eq(bankConnections.status, "active"),
        isNull(bankConnections.cursor),
      ),
    )
    .orderBy(asc(bankConnections.id))
    )
    .filter((c) => supportsToken(provider, c.accessToken));
  const out: SyncAllResult = { results: [], errors: [] };
  for (const c of conns) {
    try {
      out.results.push(await syncConnection(db, user, provider, c.id, opts));
    } catch (e) {
      out.errors.push({ connectionId: c.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * Revokes the connection at the provider (Plaid: /item/remove, which also ends Transactions
 * billing), then marks it disconnected and forgets the token. Imported transactions and the account
 * mapping stay. A login whose environment has no secret configured cannot be revoked from here
 * and is only forgotten locally. If the provider call fails for another reason, nothing
 * changes locally and the error is rethrown.
 */
export async function disconnectConnection(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  connectionId: number,
): Promise<BankConnectionSummary> {
  const conn = await getConnection(db, user, connectionId);
  if (conn.status !== "disconnected") {
    // Throws before anything changes when the token cannot be decrypted.
    const pc = providerConn(conn);
    if (supportsToken(provider, pc.accessToken)) {
      try {
        await provider.disconnect(pc);
      } catch (e) {
        if (!(e instanceof BankProviderError && e.kind === "reconnect")) throw e;
      }
    }
    await db.update(bankConnections)
      .set({ status: "disconnected", accessToken: "", lastError: null })
      .where(eq(bankConnections.id, conn.id));
  }
  return await getConnectionSummary(db, user, conn.id, provider);
}

/**
 * Stops syncing a connection without touching Plaid: the Item, its token and its Trial slot stay, the
 * scheduler and manual sync skip it until resumeConnection. Pausing a paused connection is a no-op.
 */
export async function pauseConnection(db: Db, user: CurrentUser, connectionId: number, provider?: BankProvider | null): Promise<BankConnectionSummary> {
  const conn = await getConnection(db, user, connectionId);
  if (conn.status === "disconnected") throw new BankSyncError("connection_disconnected", "bank_connection_disconnected_pause", "This bank connection is disconnected and cannot be paused");
  if (conn.status !== "paused") await db.update(bankConnections).set({ status: "paused" }).where(eq(bankConnections.id, conn.id));
  return await getConnectionSummary(db, user, conn.id, provider);
}

/** Undoes pauseConnection; the next scheduled or manual sync picks up from the stored cursor. */
export async function resumeConnection(db: Db, user: CurrentUser, connectionId: number, provider?: BankProvider | null): Promise<BankConnectionSummary> {
  const conn = await getConnection(db, user, connectionId);
  if (conn.status === "disconnected") throw disconnected();
  if (conn.status === "paused") {
    await db.update(bankConnections).set({ status: "active", lastError: null }).where(eq(bankConnections.id, conn.id));
  }
  return await getConnectionSummary(db, user, conn.id, provider);
}
