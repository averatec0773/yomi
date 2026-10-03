import { accountBalanceSnapshots, accounts, bankAccounts, bankConnections, type Db, importBatches, jobs, settlements, transactions, transactionSplits } from "@yomi/db";
import { createPlaidClient, type PlaidAccount, type PlaidEnvironment, type PlaidTransaction } from "@yomi/importers";
import { and, eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { cleanMerchant } from "../import/merchant";
import { listBatches } from "../import/pipeline";
import { addParticipant, addSplit, addTx, catId, freshDb, user } from "../ledger/test-helpers";
import { setAutoSplit } from "../split/rules";
import { plaidConfig, plaidProviderFromEnv } from "./config";
import { runBankSyncJob } from "./job";
import { createPlaidProvider } from "./plaid";
import { BankProviderError } from "./provider";
import {
  connectWithPublicToken,
  createLinkToken,
  disconnectConnection,
  listConnections,
  pauseConnection,
  resumeConnection,
  syncAll,
  syncConnection,
} from "./sync";

// Plaid API shapes (docs examples), synthetic values.
const card: PlaidAccount = {
  account_id: "acc_card",
  name: "Customized Cash Rewards",
  mask: "4321",
  type: "credit",
  subtype: "credit card",
  balances: { current: 183.24, available: 4816.76, limit: 5000, iso_currency_code: "USD", unofficial_currency_code: null },
};
const checking: PlaidAccount = {
  ...card,
  account_id: "acc_chk",
  name: "Adv Plus Banking",
  mask: "9876",
  type: "depository",
  subtype: "checking",
  balances: { current: 1019.14, available: 1000, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
};

function tx(id: string, date: string, amount: number, name: string, extra: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: id,
    account_id: "acc_card",
    amount,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date,
    authorized_date: null,
    pending: false,
    pending_transaction_id: null,
    merchant_name: null,
    name,
    personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE" },
    ...extra,
  };
}

type Change = { kind: "added" | "modified"; t: PlaidTransaction } | { kind: "removed"; id: string; account: string };

/**
 * Fake Plaid server behind the real client: an append-only change log per Item; the cursor is the
 * log position, pages of `pageSize` changes with has_more, like /transactions/sync.
 */
function fakePlaid(pageSize = 2, env: PlaidEnvironment = "sandbox") {
  const itemId = env === "sandbox" ? "item_1" : `item_${env}`;
  const log: Change[] = [];
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let error: { status: number; code: string; type: string } | null = null;
  let removeError: { status: number; code: string; type: string } | null = null;
  let accountsError: { status: number; code: string; type: string } | null = null;
  let linkTokens = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status });
    const err = (e: { status: number; code: string; type: string }) =>
      json(e.status, { error_type: e.type, error_code: e.code, error_message: "synthetic", display_message: null, request_id: "r" });
    if (path === "/item/remove") return removeError ? err(removeError) : json(200, { request_id: "r" });
    if (path === "/accounts/get" && accountsError) return err(accountsError);
    if (error) return err(error);
    switch (path) {
      case "/link/token/create":
        linkTokens += 1;
        return json(200, { link_token: linkTokens === 1 ? `link-${env}-abc` : `link-${env}-abc${linkTokens}`, expiration: "2026-09-29T04:00:00Z", request_id: "r" });
      case "/item/public_token/exchange":
        return json(200, { access_token: `access-${env}-111`, item_id: itemId, request_id: "r" });
      case "/accounts/get":
        return json(200, { accounts: [card, checking], item: { item_id: itemId, institution_name: "Bank of America" }, request_id: "r" });
      case "/transactions/sync": {
        const start = body.cursor ? Number(String(body.cursor).slice(1)) : 0;
        const slice = log.slice(start, start + pageSize);
        const end = start + slice.length;
        return json(200, {
          added: slice.flatMap((c) => (c.kind === "added" ? [c.t] : [])),
          modified: slice.flatMap((c) => (c.kind === "modified" ? [c.t] : [])),
          removed: slice.flatMap((c) => (c.kind === "removed" ? [{ transaction_id: c.id, account_id: c.account }] : [])),
          accounts: [card, checking],
          next_cursor: `c${end}`,
          has_more: end < log.length,
          transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
          request_id: "r",
        });
      }
    }
    return json(404, {});
  }) as typeof fetch;
  const client = createPlaidClient({ clientId: "cid", secret: env === "sandbox" ? "sec" : `sec-${env}`, environment: env, fetch: f });
  const provider = createPlaidProvider({ [env]: client });
  return {
    client,
    log,
    calls,
    provider,
    add: (...ts: PlaidTransaction[]) => log.push(...ts.map((t) => ({ kind: "added" as const, t }))),
    modify: (t: PlaidTransaction) => log.push({ kind: "modified", t }),
    remove: (id: string, account = "acc_card") => log.push({ kind: "removed", id, account }),
    fail: (code: string, type = "ITEM_ERROR", status = 400) => (error = { status, code, type }),
    failRemove: (code: string, type = "INVALID_INPUT", status = 400) => (removeError = { status, code, type }),
    failAccounts: (code = "INTERNAL_SERVER_ERROR", type = "API_ERROR", status = 500) => (accountsError = { status, code, type }),
    heal: () => {
      error = null;
      accountsError = null;
    },
  };
}

async function setup(pageSize = 2) {
  const db = await freshDb();
  const p = fakePlaid(pageSize);
  const conn = await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-xyz", institutionName: "Bank of America" });
  return { db, p, conn };
}

const stored = async (db: Db, id: string) =>
  (await db.select().from(transactions).where(eq(transactions.sourceRef, id)).limit(1))[0];

describe("connectWithPublicToken / createLinkToken", () => {
  it("exchanges the public token, stores the Item and maps accounts, reusing an existing card account", async () => {
    const db = await freshDb();
    const existing = (await db
      .insert(accounts)
      .values({ userId: user.id, name: "BoA card", kind: "credit_card", institution: "Bank of America", last4: "4321", currency: "USD" })
      .returning())[0]!;
    const p = fakePlaid();
    const conn = await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-xyz", institutionName: "Bank of America" });
    expect(p.calls[0]!.body).toMatchObject({ public_token: "public-sandbox-xyz", client_id: "cid", secret: "sec" });
    expect(conn).toMatchObject({ provider: "plaid", environment: "sandbox", institutionName: "Bank of America", status: "active" });
    expect(conn.accounts.map((a) => [a.name, a.lastFour, a.type])).toEqual([
      ["Customized Cash Rewards", "4321", "credit"],
      ["Adv Plus Banking", "9876", "depository"],
    ]);
    expect(conn.accounts[0]!.accountId).toBe(existing.id);
    const chk = (await db.select().from(accounts).where(eq(accounts.id, conn.accounts[1]!.accountId)).limit(1))[0]!;
    expect(chk).toMatchObject({ kind: "debit_card", institution: "Bank of America", last4: "9876", name: "Bank of America Adv Plus Banking 9876" });
    const row = (await db.select().from(bankConnections).limit(1))[0]!;
    expect(row).toMatchObject({ enrollmentId: "item_1", accessToken: "access-sandbox-111", cursor: null });

    // The same Item again updates, never duplicates.
    await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-2", institutionName: "Bank of America" });
    expect(await db.select().from(bankConnections)).toHaveLength(1);
    expect(await db.select().from(bankAccounts)).toHaveLength(2);
  });

  it("keeps the access token when accounts/get fails right after the exchange", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    p.failAccounts();
    const conn = await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-acc", institutionName: "Bank of America" });
    expect(conn).toMatchObject({ status: "error", reused: false, institutionName: "Bank of America", accounts: [] });
    expect(conn.lastError).toBeTruthy();
    expect((await db.select().from(bankConnections).limit(1))[0]).toMatchObject({ accessToken: "access-sandbox-111", enrollmentId: "item_1", status: "error" });

    p.heal();
    p.add(tx("a1", "2026-09-10", 5, "A"));
    expect((await syncConnection(db, user, p.provider, conn.id, { backup: false })).inserted).toBe(1);
    expect((await listConnections(db, user))[0]).toMatchObject({ status: "active", lastError: null });
  });

  it("a retried exchange with the same public token returns the same connection without calling Plaid again", async () => {
    const db = await freshDb();
    const p = fakePlaid();
    let t = 1_000_000;
    const now = () => t;
    const input = { publicToken: "public-sandbox-retry", institutionName: "Bank of America" };
    const first = await connectWithPublicToken(db, user, p.provider, input, now);
    const exchanges = () => p.calls.filter((c) => c.path === "/item/public_token/exchange").length;
    const callsAfterFirst = p.calls.length;
    const again = await connectWithPublicToken(db, user, p.provider, input, now);
    expect(again).toMatchObject({ id: first.id, reused: true });
    expect(p.calls.length).toBe(callsAfterFirst);
    expect(await db.select().from(bankConnections)).toHaveLength(1);

    // After 30 minutes the token is dead at Plaid anyway; the call goes through and still updates the same Item.
    t += 30 * 60 * 1000;
    expect((await connectWithPublicToken(db, user, p.provider, input, now)).reused).toBe(false);
    expect(exchanges()).toBe(2);
    expect(await db.select().from(bankConnections)).toHaveLength(1);
  });

  it("link token: products for a new login, access_token (update mode) for an existing one", async () => {
    const { db, p, conn } = await setup();
    p.calls.length = 0;
    expect((await createLinkToken(db, user, p.provider)).linkToken).toBe("link-sandbox-abc");
    expect(p.calls[0]!.body).toMatchObject({ products: ["transactions"], user: { client_user_id: String(user.id) } });
    await createLinkToken(db, user, p.provider, { connectionId: conn.id });
    expect(p.calls[1]!.body).toMatchObject({ access_token: "access-sandbox-111" });
    expect(p.calls[1]!.body.products).toBeUndefined();
  });
});

describe("syncConnection", () => {
  it("follows has_more across pages, imports posted rows as one plaid batch, skips pending; a second sync inserts 0", async () => {
    const { db, p, conn } = await setup(2);
    p.add(
      tx("t1", "2026-09-10", 12.5, "CHIPOTLE 1234", { merchant_name: "Chipotle", personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_FAST_FOOD" } }),
      tx("t2", "2026-09-11", 40, "SHELL OIL 5566", { personal_finance_category: { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" } }),
      tx("t3", "2026-09-12", -300, "PAYMENT - THANK YOU", { personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" } }),
      tx("tp", "2026-09-13", 9.99, "NETFLIX", { pending: true }),
      tx("t4", "2026-09-12", 300, "BK OF AMER CRD 4321 PAYMENT", {
        account_id: "acc_chk",
        personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
      }),
    );
    const r1 = await syncConnection(db, user, p.provider, conn.id, { backup: false });
    expect(p.calls.filter((c) => c.path === "/transactions/sync").map((c) => c.body.cursor ?? null)).toEqual([null, "c2", "c4"]);
    expect(r1).toMatchObject({ fetched: 4, inserted: 4, skippedDup: 0, modified: 0, removed: 0 });
    const rows = await db.select().from(transactions).where(eq(transactions.source, "plaid"));
    expect(rows.map((r) => [r.dedupKey, r.amountMinor, r.kind, r.currency]).sort()).toEqual(
      [
        ["plaid:t1", -1250, "expense", "USD"],
        ["plaid:t2", -4000, "expense", "USD"],
        ["plaid:t3", 30000, "transfer", "USD"],
        ["plaid:t4", -30000, "transfer", "USD"],
      ].sort(),
    );
    expect((await stored(db, "t1"))!.categoryId).toBe(await catId(db, "餐饮"));
    expect((await stored(db, "t2"))!.categoryId).toBe(await catId(db, "交通"));
    expect((await stored(db, "t1"))!.accountId).toBe(conn.accounts[0]!.accountId);
    expect((await stored(db, "t4"))!.accountId).toBe(conn.accounts[1]!.accountId);
    expect((await db.select().from(bankConnections).limit(1))[0]!.cursor).toBe("c5");

    const batch = (await db.select().from(importBatches).where(eq(importBatches.id, r1.batchId!)).limit(1))[0]!;
    expect(batch.source).toBe("plaid");
    expect(batch.declared).toBeNull();
    expect((await listBatches(db, user))[0]!.declared).toBeNull();

    // Same cursor, nothing new: no batch, nothing inserted.
    const r2 = await syncConnection(db, user, p.provider, conn.id, { backup: false });
    expect(r2).toMatchObject({ inserted: 0, batchId: null, fetched: 0 });
    // Replaying from an old cursor (crash before the cursor moved) dedups.
    await db.update(bankConnections).set({ cursor: null });
    const r3 = await syncConnection(db, user, p.provider, conn.id, { backup: false });
    expect(r3).toMatchObject({ inserted: 0, batchId: null, skippedDup: 4 });
    expect(await db.select().from(importBatches)).toHaveLength(1);
    expect((await listConnections(db, user))[0]!.lastSyncedAt).not.toBeNull();
  });

  it("snapshots each account's balance on the sync day: checking as cash, the card as owed (negative)", async () => {
    const { db, p, conn } = await setup(2);
    await syncConnection(db, user, p.provider, conn.id, { backup: false, now: () => new Date("2026-09-29T20:00:00Z") });
    const rows = await db.select().from(accountBalanceSnapshots);
    const byAccount = new Map(conn.accounts.map((a) => [a.accountId, a.name]));
    expect(rows.map((r) => [byAccount.get(r.accountId), r.asOf, r.balanceMinor, r.currency, r.source]).sort()).toEqual(
      [
        ["Adv Plus Banking", "2026-09-30", 101914, "USD", "plaid"],
        ["Customized Cash Rewards", "2026-09-30", -18324, "USD", "plaid"],
      ].sort(),
    );
    // A second sync the same day replaces, not duplicates.
    await syncConnection(db, user, p.provider, conn.id, { backup: false, now: () => new Date("2026-09-29T21:00:00Z") });
    expect(await db.select().from(accountBalanceSnapshots)).toHaveLength(2);
  });

  it("modified: updates amount, date and merchant of an untouched row; warns for an edited or split row", async () => {
    const { db, p, conn } = await setup();
    p.add(tx("m1", "2026-09-10", 10, "TST* CAFE", { merchant_name: "Cafe" }), tx("m2", "2026-09-10", 20, "DINER"), tx("m3", "2026-09-10", 30, "BAR"));
    await syncConnection(db, user, p.provider, conn.id, { backup: false });
    const before = (await stored(db, "m1"))!;
    await db.update(transactions).set({ userEditedAt: "2026-09-12T00:00:00Z" }).where(eq(transactions.sourceRef, "m2"));
    await addSplit(db, (await stored(db, "m3"))!.id, await addParticipant(db, "小李"), 1500, 0, "USD");

    p.modify(tx("m1", "2026-09-11", 12.34, "TST* CAFE", { merchant_name: "Cafe Nero" }));
    p.modify(tx("m2", "2026-09-11", 25, "DINER"));
    p.modify(tx("m3", "2026-09-11", 35, "BAR"));
    p.modify(tx("m4", "2026-09-11", 7, "NEW POSTED")); // never stored: treated as added
    const r = await syncConnection(db, user, p.provider, conn.id, { backup: false });
    expect(r).toMatchObject({ modified: 1, inserted: 1 });
    const m1 = (await stored(db, "m1"))!;
    expect(m1).toMatchObject({ id: before.id, amountMinor: -1234, occurredAt: "2026-09-11T12:00:00-05:00", merchant: cleanMerchant("Cafe Nero") });
    expect(m1.categoryId).toBe(before.categoryId);
    expect((await stored(db, "m2"))!.amountMinor).toBe(-2000);
    expect((await stored(db, "m3"))!.amountMinor).toBe(-3000);
    const locked = r.warnings.filter((w) => w.code === "sync_modified_locked");
    expect(locked).toHaveLength(2);
    expect(locked.map((w) => w.params.reason).sort()).toEqual(["edited", "split"]);
  });

  it("removed: deletes an untouched row, keeps a settled one with a warning, ignores unknown ids", async () => {
    const { db, p, conn } = await setup();
    p.add(tx("r1", "2026-09-10", 10, "A"), tx("r2", "2026-09-10", 20, "B"));
    await syncConnection(db, user, p.provider, conn.id, { backup: false });
    const friend = await addParticipant(db, "小王");
    await db.insert(settlements)
      .values({ userId: user.id, participantId: friend, amountMinor: 2000, currency: "USD", settledOn: "2026-09-10", transactionId: (await stored(db, "r2"))!.id });
    p.remove("r1");
    p.remove("r2");
    p.remove("pending_never_stored");
    const r = await syncConnection(db, user, p.provider, conn.id, { backup: false });
    expect(r).toMatchObject({ removed: 1, inserted: 0 });
    expect(await stored(db, "r1")).toBeUndefined();
    expect(await stored(db, "r2")).toBeDefined();
    expect(r.warnings).toMatchObject([{ code: "sync_removed_locked", params: { reason: "settled" } }]);
  });

  it("applies merchant auto-split rules to synced rows", async () => {
    const db = await freshDb();
    const friend = await addParticipant(db, "小王");
    await setAutoSplit(db, user, cleanMerchant("Costco"), { participantIds: [friend], enabled: true });
    const p = fakePlaid();
    p.add(tx("tc", "2026-09-10", 100, "COSTCO WHSE #1234", { merchant_name: "Costco" }));
    const conn = await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-xyz", institutionName: "Bank of America" });
    const r = await syncConnection(db, user, p.provider, conn.id, { backup: false });
    expect(r.autoSplit).toBe(1);
    const splits = await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, (await stored(db, "tc"))!.id));
    expect(splits.map((s) => s.owedMinor).sort()).toEqual([5000, 5000]);
  });

  it("links a synced card row to the WeChat row paid with that card", async () => {
    const db = await freshDb();
    const wx = await addTx(db, {
      source: "wechat",
      amountMinor: -1999,
      currency: "USD",
      occurredAt: "2026-09-09T20:00:00+08:00",
      paymentMethod: "Bank of America信用卡(4321)",
    });
    const p = fakePlaid();
    p.add(tx("tw", "2026-09-10", 19.99, "TENPAY*WECHAT"));
    const conn = await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-xyz", institutionName: "Bank of America" });
    const r = await syncConnection(db, user, p.provider, conn.id, { backup: false });
    expect(r.linked).toBe(1);
    expect((await stored(db, "tw"))!.duplicateOfId).toBe(wx);
  });

  it("ITEM_LOGIN_REQUIRED marks the connection as error; a later successful sync clears it", async () => {
    const { db, p, conn } = await setup();
    p.fail("ITEM_LOGIN_REQUIRED");
    const err = await syncConnection(db, user, p.provider, conn.id, { backup: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankProviderError);
    expect(err).toMatchObject({ reason: "reconnect", providerCode: "ITEM_LOGIN_REQUIRED" });
    const c = (await listConnections(db, user))[0]!;
    expect(c.status).toBe("error");
    expect(c.lastError).toContain("ITEM_LOGIN_REQUIRED");
    expect(c.lastError).toContain("Reconnect");
    expect((await syncAll(db, user, p.provider, { backup: false })).errors).toHaveLength(1);

    p.heal(); // the user went through update mode
    await syncConnection(db, user, p.provider, conn.id, { backup: false });
    expect((await listConnections(db, user))[0]).toMatchObject({ status: "active", lastError: null });
  });

  it("refuses a login whose environment has no secret and syncAll skips it", async () => {
    const { db, p, conn } = await setup();
    await db.update(bankConnections).set({ accessToken: "access-production-999" });
    await expect(syncConnection(db, user, p.provider, conn.id, { backup: false })).rejects.toMatchObject({
      kind: "conflict",
      code: "bank_environment_unavailable_connection",
      params: { environment: "Production", secretVar: "PLAID_SECRET_PRODUCTION" },
      message: "This connection is in the Production environment, but PLAID_SECRET_PRODUCTION is not configured",
    });
    expect((await syncAll(db, user, p.provider, { backup: false })).results).toHaveLength(0);
    expect((await listConnections(db, user))[0]!.environment).toBe("production");
  });
});

describe("two environments at once", () => {
  async function twoEnvs() {
    const db = await freshDb();
    const sb = fakePlaid(2, "sandbox");
    const prod = fakePlaid(2, "production");
    const both = createPlaidProvider({ sandbox: sb.client, production: prod.client }, { defaultEnvironment: "production" });
    const sbConn = await connectWithPublicToken(db, user, both, { publicToken: "public-sandbox-1", institutionName: "First Platypus" });
    const prodConn = await connectWithPublicToken(db, user, both, { publicToken: "public-production-1", institutionName: "Bank of America" });
    sb.add(tx("sb1", "2026-09-10", 5, "Sandbox shop"));
    prod.add(tx("pr1", "2026-09-11", 7, "Real shop"));
    return { db, sb, prod, both, sbConn, prodConn };
  }
  const paths = (p: ReturnType<typeof fakePlaid>) => p.calls.map((c) => c.path);

  it("routes exchange by the public token's environment and every later call by the access token's", async () => {
    const { db, sb, prod, both, sbConn, prodConn } = await twoEnvs();
    expect(both.environments).toEqual(["production", "sandbox"]);
    expect([sbConn.environment, prodConn.environment]).toEqual(["sandbox", "production"]);
    expect(sb.calls[0]!.body).toMatchObject({ public_token: "public-sandbox-1", secret: "sec" });
    expect(prod.calls[0]!.body).toMatchObject({ public_token: "public-production-1", secret: "sec-production" });

    sb.calls.length = 0;
    prod.calls.length = 0;
    expect((await syncConnection(db, user, both, sbConn.id, { backup: false })).inserted).toBe(1);
    expect(paths(sb)).toContain("/transactions/sync");
    expect(prod.calls).toHaveLength(0);

    // Update mode goes to the connection's environment; a new login to the default or the one asked for.
    await createLinkToken(db, user, both, { connectionId: sbConn.id });
    expect(sb.calls.at(-1)).toMatchObject({ path: "/link/token/create", body: { access_token: "access-sandbox-111" } });
    expect((await createLinkToken(db, user, both)).linkToken).toBe("link-production-abc");
    expect((await createLinkToken(db, user, both, { environment: "sandbox" })).linkToken).toMatch(/^link-sandbox-abc/);

    sb.calls.length = 0;
    prod.calls.length = 0;
    await disconnectConnection(db, user, both, prodConn.id);
    expect(prod.calls.map((c) => [c.path, c.body.access_token])).toEqual([["/item/remove", "access-production-111"]]);
    expect(sb.calls).toHaveLength(0);
  });

  it("syncAll syncs both when both secrets exist, and skips the one whose secret is missing", async () => {
    const { db, sb, prod, both, sbConn, prodConn } = await twoEnvs();
    const all = await syncAll(db, user, both, { backup: false });
    expect(all.errors).toEqual([]);
    expect(all.results.map((r) => [r.connectionId, r.inserted])).toEqual([
      [sbConn.id, 1],
      [prodConn.id, 1],
    ]);

    sb.add(tx("sb2", "2026-09-12", 3, "Sandbox shop"));
    prod.add(tx("pr2", "2026-09-13", 4, "Real shop"));
    const prodOnly = createPlaidProvider({ production: prod.client });
    const partial = await syncAll(db, user, prodOnly, { backup: false });
    expect(partial.results.map((r) => [r.connectionId, r.inserted])).toEqual([[prodConn.id, 1]]);
    await expect(syncConnection(db, user, prodOnly, sbConn.id, { backup: false })).rejects.toThrow(
      "This connection is in the Sandbox environment, but PLAID_SECRET_SANDBOX is not configured",
    );
    await expect(createLinkToken(db, user, prodOnly, { connectionId: sbConn.id })).rejects.toMatchObject({ kind: "conflict", code: "bank_environment_unavailable_connection" });
    await expect(createLinkToken(db, user, prodOnly, { environment: "sandbox" })).rejects.toMatchObject({ code: "bank_environment_unavailable_new" });
    expect(await stored(db, "sb2")).toBeUndefined();

    // Disconnecting a login whose environment has no secret only forgets it locally.
    sb.calls.length = 0;
    expect((await disconnectConnection(db, user, prodOnly, sbConn.id)).status).toBe("disconnected");
    expect(sb.calls).toHaveLength(0);
  });
});

describe("disconnectConnection", () => {
  it("calls /item/remove, marks it disconnected, forgets the token and keeps the rows", async () => {
    const { db, p, conn } = await setup();
    p.add(tx("d1", "2026-09-10", 5, "A"));
    await syncConnection(db, user, p.provider, conn.id, { backup: false });
    const out = await disconnectConnection(db, user, p.provider, conn.id);
    expect(p.calls.filter((c) => c.path === "/item/remove").map((c) => c.body.access_token)).toEqual(["access-sandbox-111"]);
    expect(out.status).toBe("disconnected");
    expect((await db.select().from(bankConnections).limit(1))[0]!.accessToken).toBe("");
    expect(await db.select().from(transactions)).toHaveLength(1);
    await expect(syncConnection(db, user, p.provider, conn.id)).rejects.toMatchObject({ code: "bank_connection_disconnected" });
    expect((await syncAll(db, user, p.provider)).results).toHaveLength(0);
  });

  it("treats an Item Plaid no longer knows as already removed, but keeps it on other errors", async () => {
    const a = await setup();
    a.p.failRemove("ITEM_NOT_FOUND");
    expect((await disconnectConnection(a.db, user, a.p.provider, a.conn.id)).status).toBe("disconnected");
    const b = await setup();
    b.p.failRemove("INTERNAL_SERVER_ERROR", "API_ERROR", 500);
    await expect(disconnectConnection(b.db, user, b.p.provider, b.conn.id)).rejects.toThrow();
    expect((await listConnections(b.db, user))[0]!.status).toBe("active");
  });
});

describe("pauseConnection / resumeConnection", () => {
  it("paused connections talk to nobody: manual sync refuses, syncAll and the scheduler skip them; resume picks up", async () => {
    const { db, p, conn } = await setup();
    p.add(tx("p1", "2026-09-10", 5, "A"));
    p.calls.length = 0;
    expect(await pauseConnection(db, user, conn.id)).toMatchObject({ status: "paused" });
    expect((await pauseConnection(db, user, conn.id)).status).toBe("paused");
    expect((await db.select().from(bankConnections).limit(1))[0]!.accessToken).not.toBe("");

    await expect(syncConnection(db, user, p.provider, conn.id, { backup: false })).rejects.toMatchObject({ kind: "conflict", code: "bank_connection_paused" });
    expect((await syncAll(db, user, p.provider, { backup: false })).results).toHaveLength(0);
    // Due (startup catch-up) and the every-tick first-data retry: neither touches a paused Item.
    const now = () => new Date("2026-09-29T00:00:00Z");
    const ran = await runBankSyncJob(db, user, p.provider, { now, backup: false });
    expect(ran.ran && ran.result.results).toEqual([]);
    const tick = await runBankSyncJob(db, user, p.provider, { now, backup: false });
    expect(tick).toMatchObject({ ran: false, reason: "not_due", awaiting: { results: [], errors: [] } });
    expect(p.calls).toHaveLength(0);
    expect(await stored(db, "p1")).toBeUndefined();

    expect(await resumeConnection(db, user, conn.id)).toMatchObject({ status: "active", lastError: null });
    expect((await syncConnection(db, user, p.provider, conn.id, { backup: false })).inserted).toBe(1);
  });

  it("refuses to pause or resume a disconnected connection", async () => {
    const { db, p, conn } = await setup();
    await disconnectConnection(db, user, p.provider, conn.id);
    await expect(pauseConnection(db, user, conn.id)).rejects.toThrow(expect.objectContaining({ code: "bank_connection_disconnected_pause" }));
    await expect(resumeConnection(db, user, conn.id)).rejects.toThrow(expect.objectContaining({ code: "bank_connection_disconnected" }));
    await expect(pauseConnection(db, user, 999)).rejects.toThrow(expect.objectContaining({ kind: "not_found", code: "bank_connection_not_found" }));
  });
});

describe("runBankSyncJob", () => {
  it("runs when due (startup catch-up), then waits 6 hours; a held row blocks a second run", async () => {
    const { db, p } = await setup();
    p.add(tx("j1", "2026-09-10", 5, "A"));
    let clock = new Date("2026-09-29T00:00:00Z");
    const now = () => clock;
    const first = await runBankSyncJob(db, user, p.provider, { now, backup: false });
    expect(first.ran && first.result.results[0]!.inserted).toBe(1);
    const job = (await db.select().from(jobs).where(and(eq(jobs.userId, user.id), eq(jobs.name, "bank-sync"))).limit(1))[0]!;
    expect(job).toMatchObject({ status: "idle", runAfter: "2026-09-29T06:00:00.000Z", attempts: 0 });

    clock = new Date("2026-09-29T05:59:00Z");
    expect(await runBankSyncJob(db, user, p.provider, { now, backup: false })).toMatchObject({ ran: false, reason: "not_due" });

    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    clock = new Date("2026-09-29T07:00:00Z");
    expect(await runBankSyncJob(db, user, p.provider, { now, backup: false })).toEqual({ ran: false, reason: "running" });

    await db.update(jobs).set({ status: "idle" }).where(eq(jobs.id, job.id));
    const again = await runBankSyncJob(db, user, p.provider, { now, backup: false });
    expect(again.ran && again.result.results[0]!.inserted).toBe(0);
  });
});

describe("plaidConfig", () => {
  const cid = { PLAID_CLIENT_ID: "cid_visible_nowhere" };

  it("both secrets: both environments, production by default, PLAID_ENV picks the default", () => {
    const env = { ...cid, PLAID_SECRET_SANDBOX: "sb_visible_nowhere", PLAID_SECRET_PRODUCTION: "pr_visible_nowhere" };
    const cfg = plaidConfig(env);
    expect(cfg).toEqual({ provider: "plaid", configured: true, defaultEnvironment: "production", environments: ["production", "sandbox"], missing: [] });
    expect(JSON.stringify(cfg)).not.toContain("visible_nowhere");
    expect(plaidConfig({ ...env, PLAID_ENV: " Sandbox " }).defaultEnvironment).toBe("sandbox");
    const p = plaidProviderFromEnv(env)!;
    expect([p.environments, p.defaultEnvironment]).toEqual([["production", "sandbox"], "production"]);
  });

  it("only sandbox: sandbox is the default even when PLAID_ENV says production", () => {
    const env = { ...cid, PLAID_SECRET_SANDBOX: "sb" };
    expect(plaidConfig(env)).toMatchObject({ configured: true, defaultEnvironment: "sandbox", environments: ["sandbox"] });
    expect(plaidConfig({ ...env, PLAID_ENV: "production" }).defaultEnvironment).toBe("sandbox");
    expect(plaidProviderFromEnv(env)!.environments).toEqual(["sandbox"]);
  });

  it("legacy PLAID_SECRET fills the PLAID_ENV environment (default sandbox) when its own secret is missing", () => {
    expect(plaidConfig({ ...cid, PLAID_SECRET: "s" })).toMatchObject({ configured: true, defaultEnvironment: "sandbox", environments: ["sandbox"] });
    expect(plaidConfig({ ...cid, PLAID_SECRET: "s", PLAID_ENV: "production" })).toMatchObject({
      defaultEnvironment: "production",
      environments: ["production"],
    });
    // Next to a specific secret for another environment, both are available.
    expect(plaidConfig({ ...cid, PLAID_SECRET: "s", PLAID_SECRET_PRODUCTION: "p" }).environments).toEqual(["production", "sandbox"]);
    // The specific secret wins over the legacy one for the same environment.
    expect(plaidConfig({ ...cid, PLAID_SECRET: "s", PLAID_SECRET_SANDBOX: "sb" }).environments).toEqual(["sandbox"]);
  });

  it("unconfigured: lists what is missing; an unknown PLAID_ENV is ignored", () => {
    expect(plaidConfig({})).toEqual({
      provider: "plaid",
      configured: false,
      defaultEnvironment: "sandbox",
      environments: [],
      missing: ["PLAID_CLIENT_ID", "PLAID_SECRET_PRODUCTION / PLAID_SECRET_SANDBOX"],
    });
    expect(plaidConfig({ PLAID_SECRET_PRODUCTION: "p" })).toMatchObject({ configured: false, missing: ["PLAID_CLIENT_ID"] });
    expect(plaidConfig({ ...cid, PLAID_SECRET_PRODUCTION: "p", PLAID_ENV: "development" }).defaultEnvironment).toBe("production");
    expect(plaidProviderFromEnv({ ...cid })).toBeNull();
  });
});
