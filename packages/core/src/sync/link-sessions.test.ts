import { bankConnections, type Db, jobs, plaidLinkSessions, transactions } from "@yomi/db";
import { createPlaidClient, type PlaidLinkSession, type PlaidTransaction } from "@yomi/importers";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { freshDb, user } from "../ledger/test-helpers";
import { runBankSyncJob } from "./job";
import { LINK_RECOVERY_WINDOW_MS, recoverLinkSessions } from "./link-sessions";
import { createPlaidProvider } from "./plaid";
import { connectWithPublicToken, createLinkToken } from "./sync";

const card = {
  account_id: "acc_card",
  name: "Customized Cash Rewards",
  mask: "4321",
  type: "credit",
  subtype: "credit card",
  balances: { iso_currency_code: "USD", unofficial_currency_code: null },
};

function txn(id: string, amount: number): PlaidTransaction {
  return {
    transaction_id: id,
    account_id: "acc_card",
    amount,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-09-10",
    authorized_date: null,
    pending: false,
    pending_transaction_id: null,
    merchant_name: null,
    name: `SHOP ${id}`,
    personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE" },
  };
}

/**
 * Fake Plaid behind the real client. `sessions` is what /link/token/get returns per link token
 * (Plaid's shape); each public token exchanges to the Item named in `items`.
 */
function fakePlaid() {
  const sessions = new Map<string, PlaidLinkSession[]>();
  const items = new Map<string, string>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const state = { notReady: false };
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status });
    switch (path) {
      case "/link/token/create":
        return json(200, { link_token: `link-sandbox-${++n}`, expiration: "2026-09-29T04:00:00Z", request_id: "r" });
      case "/link/token/get":
        return json(200, { link_token: body.link_token, link_sessions: sessions.get(String(body.link_token)) ?? [], request_id: "r" });
      case "/item/public_token/exchange": {
        const item = items.get(String(body.public_token));
        if (!item) return json(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN", error_message: "bad", display_message: null });
        return json(200, { access_token: `access-sandbox-${item}`, item_id: item, request_id: "r" });
      }
      case "/accounts/get":
        return json(200, { accounts: [card], item: { item_id: "x", institution_name: "Bank of America" }, request_id: "r" });
      case "/transactions/sync":
        if (state.notReady) return json(200, { added: [], modified: [], removed: [], accounts: [card], next_cursor: "", has_more: false, request_id: "r" });
        return json(200, {
          added: body.cursor ? [] : [txn("t1", 12.5), txn("t2", 40)],
          modified: [],
          removed: [],
          accounts: [card],
          next_cursor: "c1",
          has_more: false,
          request_id: "r",
        });
    }
    return json(404, {});
  }) as typeof fetch;
  const provider = createPlaidProvider({ sandbox: createPlaidClient({ clientId: "cid", secret: "sec", environment: "sandbox", fetch: f }) });
  const count = (p: string) => calls.filter((c) => c.path === p).length;
  /** The user logged in to the bank in the session opened with `linkToken`, then Link reported `exit`. */
  const itemAdded = (linkToken: string, publicToken: string, itemId: string, finished = true) => {
    items.set(publicToken, itemId);
    sessions.set(linkToken, [
      {
        link_session_id: `sess-${linkToken}`,
        started_at: "2026-09-29T10:00:00Z",
        finished_at: finished ? "2026-09-29T10:05:00Z" : null,
        exit: finished ? { error: null, metadata: { status: "connected" } } : null,
        results: { item_add_results: [{ public_token: publicToken, institution: { name: "Bank of America", institution_id: "ins_127989" } }] },
      },
    ]);
  };
  return { provider, calls, count, sessions, items, itemAdded, state };
}

const t0 = Date.parse("2026-09-29T10:00:00Z");
const at = (ms: number) => () => new Date(t0 + ms);

async function newSession(db: Db, p: ReturnType<typeof fakePlaid>) {
  const lt = await createLinkToken(db, user, p.provider);
  // Pin created_at so ages are deterministic.
  await db.update(plaidLinkSessions).set({ createdAt: new Date(t0).toISOString() }).where(eq(plaidLinkSessions.id, lt.sessionId));
  return lt;
}

const sessionRow = async (db: Db, id: number) => (await db.select().from(plaidLinkSessions).where(eq(plaidLinkSessions.id, id)).limit(1))[0]!;

describe("recoverLinkSessions", () => {
  it("persists every link token at creation", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await createLinkToken(db, user, p.provider);
    expect(await sessionRow(db, lt.sessionId)).toMatchObject({ linkToken: lt.linkToken, environment: "sandbox", purpose: "new", status: "open", connectionId: null });
  });

  it("exit after the bank login (CONNECTED, no onSuccess): the Item is recovered, stored once and synced", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-lost", "item_lost");

    const out = await recoverLinkSessions(db, user, p.provider, { sessionId: lt.sessionId, linkSessionId: "sess-from-onexit", now: at(60_000), backup: false });
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({ sessionId: lt.sessionId, institutionName: "Bank of America", sync: { inserted: 2 }, syncError: null });
    expect(out.sessions[0]).toMatchObject({ status: "recovered", exitStatus: "connected", linkSessionId: `sess-${lt.linkToken}` });
    const conns = await db.select().from(bankConnections);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ enrollmentId: "item_lost", accessToken: "access-sandbox-item_lost", status: "active" });
    expect(await db.select().from(transactions).where(eq(transactions.source, "plaid"))).toHaveLength(2);
    expect(await sessionRow(db, lt.sessionId)).toMatchObject({ status: "recovered", connectionId: conns[0]!.id, lastError: null });
  });

  it("recovery first (Link still on its last pane), then onSuccess: the exchange reuses the recovered connection", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-early", "item_early", false);
    const early = await recoverLinkSessions(db, user, p.provider, { now: at(60_000), backup: false });
    expect(early.sessions[0]).toMatchObject({ status: "open", recovered: [{ institutionName: "Bank of America" }] });
    const conn = await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-early", institutionName: "Bank of America", linkSessionId: lt.sessionId });
    expect(conn).toMatchObject({ id: early.recovered[0]!.connectionId, reused: true });
    expect(p.count("/item/public_token/exchange")).toBe(1);
    p.itemAdded(lt.linkToken, "public-sandbox-early", "item_early", true);
    expect((await recoverLinkSessions(db, user, p.provider, { now: at(120_000), backup: false })).sessions[0]!.status).toBe("recovered");
    expect(await db.select().from(bankConnections)).toHaveLength(1);
  });

  it("page reload with no frontend callback: the mount-time call (no session id) recovers it", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-reload", "item_reload");
    const out = await recoverLinkSessions(db, user, p.provider, { now: at(5 * 60_000), backup: false });
    expect(out.recovered.map((r) => r.institutionName)).toEqual(["Bank of America"]);
    expect(await db.select().from(bankConnections)).toHaveLength(1);
  });

  it("is idempotent: repeated and concurrent recoveries exchange once and never duplicate the Item", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-twice", "item_twice");
    const [a, b] = await Promise.all([
      recoverLinkSessions(db, user, p.provider, { sessionId: lt.sessionId, now: at(60_000), backup: false }),
      recoverLinkSessions(db, user, p.provider, { now: at(60_000), backup: false }),
    ]);
    expect(a.recovered.length + b.recovered.length).toBe(1);
    const c = await recoverLinkSessions(db, user, p.provider, { sessionId: lt.sessionId, now: at(120_000), backup: false });
    expect(c.recovered).toEqual([]);
    expect(c.sessions).toMatchObject([{ id: lt.sessionId, status: "recovered" }]);
    expect(p.count("/item/public_token/exchange")).toBe(1);
    expect(await db.select().from(bankConnections)).toHaveLength(1);

    // Reopened by hand: the recorded public token is skipped, the status settles again.
    await db.update(plaidLinkSessions).set({ status: "open" });
    const d = await recoverLinkSessions(db, user, p.provider, { now: at(180_000), backup: false });
    expect(d.sessions[0]).toMatchObject({ status: "recovered", alreadyConnected: 1, recovered: [] });
    expect(p.count("/item/public_token/exchange")).toBe(1);
  });

  it("after a normal onSuccess exchange the double check marks it completed without a second exchange", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-cb", "item_cb");
    await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-cb", institutionName: "Bank of America", linkSessionId: lt.sessionId });
    const out = await recoverLinkSessions(db, user, p.provider, { sessionId: lt.sessionId, now: at(60_000), backup: false });
    expect(out.recovered).toEqual([]);
    expect(out.sessions[0]).toMatchObject({ status: "completed", alreadyConnected: 1 });
    expect(p.count("/item/public_token/exchange")).toBe(1);

    // A different public token for an Item yomi already holds: exchanged, recognized, not stored twice.
    const lt2 = await newSession(db, p);
    p.itemAdded(lt2.linkToken, "public-sandbox-other", "item_cb");
    const out2 = await recoverLinkSessions(db, user, p.provider, { now: at(60_000), backup: false });
    expect(out2.sessions[0]).toMatchObject({ status: "completed", alreadyConnected: 1, recovered: [] });
    expect(await db.select().from(bankConnections)).toHaveLength(1);
  });

  it("keeps a session open while the user is still in Link, and abandons it once the token expired empty", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await newSession(db, p);
    expect((await recoverLinkSessions(db, user, p.provider, { now: at(60_000) })).sessions[0]!.status).toBe("open");
    p.sessions.set(lt.linkToken, [{ link_session_id: "s", started_at: "x", finished_at: null }]);
    expect((await recoverLinkSessions(db, user, p.provider, { now: at(60_000) })).sessions[0]!.status).toBe("open");
    p.sessions.set(lt.linkToken, [{ link_session_id: "s", started_at: "x", finished_at: "y", exit: { error: null, metadata: { status: "requires_credentials" } } }]);
    expect((await recoverLinkSessions(db, user, p.provider, { now: at(60_000) })).sessions[0]).toMatchObject({ status: "abandoned", exitStatus: "requires_credentials" });

    const lt2 = await newSession(db, p);
    expect((await recoverLinkSessions(db, user, p.provider, { now: at(4 * 3600_000 + 1) })).sessions[0]).toMatchObject({ id: lt2.sessionId, status: "abandoned" });
  });

  it("a failed exchange keeps the session open with the error, and a later call finishes it", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-flaky", "item_flaky");
    p.items.delete("public-sandbox-flaky");
    const bad = await recoverLinkSessions(db, user, p.provider, { now: at(60_000), backup: false });
    expect(bad.sessions[0]).toMatchObject({ status: "open", recovered: [] });
    expect(bad.sessions[0]!.error).toContain("INVALID_PUBLIC_TOKEN");
    expect((await sessionRow(db, lt.sessionId)).lastError).toContain("INVALID_PUBLIC_TOKEN");
    p.items.set("public-sandbox-flaky", "item_flaky");
    const good = await recoverLinkSessions(db, user, p.provider, { now: at(120_000), backup: false });
    expect(good.sessions[0]).toMatchObject({ status: "recovered", error: null });
  });

  it("a session too old for Plaid to hold its data is marked expired without calling Plaid", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-old", "item_old");
    const out = await recoverLinkSessions(db, user, p.provider, { now: at(LINK_RECOVERY_WINDOW_MS + 1) });
    expect(out.sessions[0]).toMatchObject({ status: "expired", recovered: [] });
    expect(p.count("/link/token/get")).toBe(0);
    expect(await db.select().from(bankConnections)).toHaveLength(0);
    expect(LINK_RECOVERY_WINDOW_MS).toBeGreaterThan(6 * 3600_000);
  });

  it("update-mode sessions never create connections", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    p.items.set("public-sandbox-first", "item_a");
    const conn = await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-first", institutionName: "Bank of America" });
    const lt = await createLinkToken(db, user, p.provider, { connectionId: conn.id });
    expect(await sessionRow(db, lt.sessionId)).toMatchObject({ purpose: "update", connectionId: conn.id });
    // Even if Plaid lists a public token (another Item) for the session, update mode must not add it.
    p.itemAdded(lt.linkToken, "public-sandbox-upd", "item_other");
    const exchanges = p.count("/item/public_token/exchange");
    const out = await recoverLinkSessions(db, user, p.provider, { sessionId: lt.sessionId, backup: false });
    expect(out.sessions[0]).toMatchObject({ purpose: "update", status: "completed", recovered: [] });
    expect(p.count("/item/public_token/exchange")).toBe(exchanges);
    expect(await db.select().from(bankConnections)).toHaveLength(1);
  });

  it("the bank-sync job recovers open sessions on every tick, even when the sync itself is not due", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    await db.insert(jobs).values({ userId: user.id, name: "bank-sync", status: "idle", runAfter: "2099-01-01T00:00:00.000Z" });
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-job", "item_job");
    const out = await runBankSyncJob(db, user, p.provider, { now: at(10 * 60_000), backup: false });
    expect(out).toMatchObject({ ran: false, reason: "not_due" });
    expect(out.recovery?.recovered).toHaveLength(1);
    expect(await db.select().from(bankConnections)).toHaveLength(1);
    // Nothing open any more: the next tick does not call Plaid for sessions.
    await runBankSyncJob(db, user, p.provider, { now: at(20 * 60_000), backup: false });
    expect(p.count("/link/token/get")).toBe(1);
  });

  it("an Item whose transactions are not ready yet is re-synced on the next tick until the first data arrives", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    await db.insert(jobs).values({ userId: user.id, name: "bank-sync", status: "idle", runAfter: "2099-01-01T00:00:00.000Z" });
    const lt = await newSession(db, p);
    p.itemAdded(lt.linkToken, "public-sandbox-slow", "item_slow");
    p.state.notReady = true;
    const out = await recoverLinkSessions(db, user, p.provider, { now: at(60_000), backup: false, firstDataRetryMs: [0] });
    expect(out.recovered[0]!.sync).toMatchObject({ fetched: 0, inserted: 0 });
    expect(p.count("/transactions/sync")).toBe(2);
    expect((await db.select().from(bankConnections).limit(1))[0]!.cursor).toBeNull();

    p.state.notReady = false;
    const tick = await runBankSyncJob(db, user, p.provider, { now: at(10 * 60_000), backup: false });
    expect(tick).toMatchObject({ ran: false, reason: "not_due" });
    expect(tick.awaiting?.results.map((r) => r.inserted)).toEqual([2]);
    const again = await runBankSyncJob(db, user, p.provider, { now: at(20 * 60_000), backup: false });
    expect(again.awaiting?.results).toEqual([]);
  });
});
