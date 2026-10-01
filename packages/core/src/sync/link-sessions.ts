import { bankConnections, type Db, plaidLinkSessions } from "@yomi/db";
import { and, asc, eq } from "@yomi/db/orm";
import { openSecret } from "../secrets/crypto";
import { assertSecretsUsable } from "../secrets/tokens";
import type { CurrentUser } from "../user";
import { getLinkSession, type LinkSessionRow, markExchanged, parseExchanged, publicTokenHash } from "./link-session-store";
import type { BankProvider, ProviderLinkSession } from "./provider";
import { saveEnrollment, syncConnection, type SyncResult } from "./sync";

/** A new-login link token lives 4 hours, an update-mode one 30 minutes (https://plaid.com/docs/api/link/). */
export const LINK_TOKEN_LIFETIME_MS = { new: 4 * 60 * 60 * 1000, update: 30 * 60 * 1000 } as const;
/** Plaid keeps session data "for up to six hours after the session has ended" (/link/token/get). */
export const LINK_SESSION_DATA_MS = 6 * 60 * 60 * 1000;
/**
 * After this age a session is marked expired without asking Plaid: the latest a session can end is
 * when its token expires (4 h), and its data is gone 6 h later.
 */
export const LINK_RECOVERY_WINDOW_MS = LINK_TOKEN_LIFETIME_MS.new + LINK_SESSION_DATA_MS;

/** Waits before re-syncing a just-recovered Item whose transactions Plaid has not prepared yet. */
const FIRST_DATA_RETRY_MS = [3000, 6000];

async function hasCursor(db: Db, id: number): Promise<boolean> {
  return (await db.select({ cursor: bankConnections.cursor }).from(bankConnections).where(eq(bankConnections.id, id)).limit(1))[0]?.cursor != null;
}

export interface RecoveredItem {
  sessionId: number;
  connectionId: number;
  institutionName: string | null;
  sync: SyncResult | null;
  syncError: string | null;
}

export interface LinkSessionOutcome {
  id: number;
  purpose: "new" | "update";
  status: LinkSessionRow["status"];
  /** Plaid's link_session_id (for support), when known. */
  linkSessionId: string | null;
  exitStatus: string | null;
  /** Logins this call saved that the browser never delivered. */
  recovered: RecoveredItem[];
  /** Logins Plaid reports for the session that yomi already had. */
  alreadyConnected: number;
  error: string | null;
}

export interface LinkRecoveryResult {
  sessions: LinkSessionOutcome[];
  recovered: RecoveredItem[];
}

type Lock = Promise<unknown>;
const locks = ((globalThis as unknown as { yomiLinkRecoveryLocks?: WeakMap<Db, Lock> }).yomiLinkRecoveryLocks ??= new WeakMap());

/** One recovery at a time per database (onExit, page mount and the job can fire together). */
function serialized<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(db) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    db,
    run.catch(() => {}),
  );
  return run;
}

async function openSessions(db: Db, user: CurrentUser): Promise<LinkSessionRow[]> {
  return await db
    .select()
    .from(plaidLinkSessions)
    .where(and(eq(plaidLinkSessions.userId, user.id), eq(plaidLinkSessions.status, "open")))
    .orderBy(asc(plaidLinkSessions.id));
}

export async function hasOpenLinkSessions(db: Db, user: CurrentUser): Promise<boolean> {
  return (await openSessions(db, user)).length > 0;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Makes sure every Item Plaid created in a yomi Link session ends up in yomi, even when the browser
 * never delivered the public token (Link closed before the last pane, page reloaded). For each open
 * session (or just `sessionId`) it asks Plaid which Items the session added (/link/token/get) and
 * exchanges every public token not exchanged yet, persisting the access token before anything else;
 * an Item yomi already has is never stored twice (bank_connections is unique per item_id). Update-mode
 * sessions never create connections. Newly recovered connections get a first sync.
 *
 * Status: `open` while the user may still be in Link or an exchange failed (retried next time);
 * `recovered` when this path saved at least one Item; `completed` when the browser callback saved
 * them all (or an update-mode session finished); `abandoned` when the session ended without an Item;
 * `expired` when it is too old for Plaid to still hold its data.
 */
export async function recoverLinkSessions(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  opts: { sessionId?: number; linkSessionId?: string | null; now?: () => Date; backup?: boolean; firstDataRetryMs?: number[] } = {},
): Promise<LinkRecoveryResult> {
  return serialized(db, async () => {
    // Nothing is asked of Plaid or written while stored tokens cannot be decrypted (or the key is malformed).
    await assertSecretsUsable(db);
    const now = opts.now ?? (() => new Date());
    let rows = await openSessions(db, user);
    if (opts.sessionId != null) {
      rows = rows.filter((r) => r.id === opts.sessionId);
      if (opts.linkSessionId) {
        await db.update(plaidLinkSessions)
          .set({ linkSessionId: opts.linkSessionId })
          .where(and(eq(plaidLinkSessions.userId, user.id), eq(plaidLinkSessions.id, opts.sessionId)));
      }
    }
    const out: LinkRecoveryResult = { sessions: [], recovered: [] };
    if (opts.sessionId != null && rows.length === 0) {
      // Already settled (by an earlier call, the job or the page mount): report how it ended.
      const row = await getLinkSession(db, user, opts.sessionId);
      if (row) out.sessions.push(settled(row));
    }
    for (const row of rows) {
      if (!provider.environments.includes(row.environment)) continue;
      const o = await recoverOne(db, user, provider, row, now, opts);
      out.sessions.push(o);
      out.recovered.push(...o.recovered);
    }
    return out;
  });
}

async function recoverOne(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  row: LinkSessionRow,
  now: () => Date,
  opts: { linkSessionId?: string | null; backup?: boolean; firstDataRetryMs?: number[] },
): Promise<LinkSessionOutcome> {
  const t = now();
  const age = t.getTime() - Date.parse(row.createdAt);
  const outcome: LinkSessionOutcome = {
    id: row.id,
    purpose: row.purpose,
    status: row.status,
    linkSessionId: opts.linkSessionId ?? row.linkSessionId,
    exitStatus: null,
    recovered: [],
    alreadyConnected: 0,
    error: null,
  };
  const save = async (set: Partial<typeof plaidLinkSessions.$inferInsert>) => {
    await db.update(plaidLinkSessions)
      .set({ checkedAt: t.toISOString(), ...set })
      .where(eq(plaidLinkSessions.id, row.id));
    if (set.status) outcome.status = set.status;
  };

  if (age > LINK_RECOVERY_WINDOW_MS) {
    await save({ status: "expired" });
    return outcome;
  }

  let sessions: ProviderLinkSession[];
  try {
    sessions = await provider.getLinkSessions(openSecret(row.linkToken), { environment: row.environment });
  } catch (e) {
    outcome.error = errorText(e);
    await save({ lastError: outcome.error });
    return outcome;
  }
  const last = sessions.at(-1);
  if (last) {
    outcome.linkSessionId = last.linkSessionId;
    outcome.exitStatus = last.exitStatus;
  }
  const items = sessions.flatMap((s) => s.items);
  const tokenExpired = age > LINK_TOKEN_LIFETIME_MS[row.purpose];
  const ended = tokenExpired || (sessions.length > 0 && sessions.every((s) => s.finished));

  if (row.purpose === "update") {
    // Update mode repairs an existing Item; any public token it yields is not a new login.
    if (ended) await save({ status: items.length ? "completed" : "abandoned", linkSessionId: outcome.linkSessionId, lastError: null });
    else await save({ linkSessionId: outcome.linkSessionId });
    return outcome;
  }

  const errors: string[] = [];
  for (const item of items) {
    const done = parseExchanged(await getRowExchanged(db, row.id));
    if (done.some((e) => e.h === publicTokenHash(item.publicToken))) {
      outcome.alreadyConnected += 1;
      continue;
    }
    let exchanged: { accessToken: string; enrollmentId: string };
    try {
      exchanged = await provider.exchangePublicToken(item.publicToken, { environment: row.environment });
    } catch (e) {
      errors.push(errorText(e));
      continue;
    }
    const existing = (await db
      .select({ id: bankConnections.id, status: bankConnections.status })
      .from(bankConnections)
      .where(
        and(eq(bankConnections.userId, user.id), eq(bankConnections.provider, provider.id), eq(bankConnections.enrollmentId, exchanged.enrollmentId)),
      )
      .limit(1))[0];
    if (existing && existing.status !== "disconnected") {
      // The browser already saved this Item (with another public token): nothing to add.
      await markExchanged(db, user, row.id, item.publicToken, "callback", existing.id);
      outcome.alreadyConnected += 1;
      continue;
    }
    // saveEnrollment writes the connection row with the access token first, then maps accounts.
    const conn = await saveEnrollment(db, user, provider, { ...exchanged, institutionName: item.institutionName, kind: row.kind });
    await markExchanged(db, user, row.id, item.publicToken, "recovery", conn.id);
    const rec: RecoveredItem = { sessionId: row.id, connectionId: conn.id, institutionName: conn.institutionName, sync: null, syncError: null };
    if (conn.status === "error") rec.syncError = conn.lastError;
    else if (conn.kind === "brokerage") {
      // Brokerage logins have no transactions sync; the holdings-sync job picks them up.
    } else {
      // Plaid often has no transactions for a brand-new Item for a few seconds: retry briefly,
      // after that the scheduler tick picks it up (syncAwaitingFirstData).
      for (const wait of [0, ...(opts.firstDataRetryMs ?? FIRST_DATA_RETRY_MS)]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        try {
          rec.sync = await syncConnection(db, user, provider, conn.id, { backup: opts.backup, now });
          rec.syncError = null;
        } catch (e) {
          rec.syncError = errorText(e);
          break;
        }
        if (rec.sync.fetched > 0 || await hasCursor(db, conn.id)) break;
      }
    }
    outcome.recovered.push(rec);
  }

  outcome.error = errors.length ? errors.join("; ") : null;
  const all = parseExchanged(await getRowExchanged(db, row.id));
  const set: Partial<typeof plaidLinkSessions.$inferInsert> = { linkSessionId: outcome.linkSessionId, lastError: outcome.error };
  if (ended && errors.length === 0) {
    set.status = all.some((e) => e.via === "recovery") ? "recovered" : all.length ? "completed" : "abandoned";
  }
  await save(set);
  return outcome;
}

function settled(row: LinkSessionRow): LinkSessionOutcome {
  return {
    id: row.id,
    purpose: row.purpose,
    status: row.status,
    linkSessionId: row.linkSessionId,
    exitStatus: null,
    recovered: [],
    alreadyConnected: parseExchanged(row.exchanged).length,
    error: row.lastError,
  };
}

async function getRowExchanged(db: Db, id: number): Promise<unknown> {
  return (await db.select({ exchanged: plaidLinkSessions.exchanged }).from(plaidLinkSessions).where(eq(plaidLinkSessions.id, id)).limit(1))[0]?.exchanged ?? null;
}
