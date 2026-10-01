import { BankConfig, BankConnectionList, BankConnectionView, BankSyncResult, EnrollmentResult, LinkRecoveryResult, LinkTokenResult } from "@yomi/contracts";
import { type BankConfig as CoreBankConfig, type BankProvider, BankProviderError, plaidConfig, type ProviderLinkSession, SECRET_UNAVAILABLE_MESSAGE, seed } from "@yomi/core";
import { bankConnections } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import type { NormalizedRow } from "@yomi/importers";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "./index";

const configured: CoreBankConfig = {
  provider: "plaid",
  configured: true,
  defaultEnvironment: "sandbox",
  environments: ["sandbox"],
  missing: [],
};

function row(id: string, amountMinor: number): NormalizedRow {
  return {
    source: "plaid",
    lineNo: 1,
    externalId: id,
    occurredAt: "2026-09-10T12:00:00-05:00",
    amountMinor,
    currency: "USD",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: amountMinor < 0 ? "out" : "in",
    kind: amountMinor < 0 ? "expense" : "income",
    status: "ok",
    counterparty: "SHOP",
    description: "SHOP",
    sourceCategory: null,
    paymentMethod: "Bank of America Card (4321)",
    raw: {},
  };
}

function fakeProvider(environments = ["sandbox"]) {
  const linkCalls: { clientUserId: string; accessToken?: string; environment?: string }[] = [];
  let failSync = false;
  const p = {
    id: "plaid" as const,
    source: "plaid" as const,
    environments,
    defaultEnvironment: environments[0]!,
    tokenEnvironment: (t: string) => /^access-(\w+)-/.exec(t)?.[1] ?? null,
    disconnected: 0,
    exchanges: 0,
    failAccounts: false,
    linkCalls,
    failNextSync: () => (failSync = true),
    createLinkToken: async (o: { clientUserId: string; accessToken?: string; environment?: string }) => {
      linkCalls.push(o);
      return { linkToken: `link-sandbox-${linkCalls.length}`, expiration: "2026-09-29T04:00:00Z" };
    },
    /** What /link/token/get reports per link token. */
    linkSessions: new Map<string, ProviderLinkSession[]>(),
    getLinkSessions: async (linkToken: string): Promise<ProviderLinkSession[]> => p.linkSessions.get(linkToken) ?? [],
    exchangePublicToken: async (pt: string) => {
      p.exchanges++;
      if (pt !== "public-sandbox-ok") throw new BankProviderError("other", "INVALID_PUBLIC_TOKEN", 400, "INVALID_PUBLIC_TOKEN");
      return { accessToken: "access-sandbox-secret", enrollmentId: "item_1" };
    },
    listAccounts: async () => {
      if (p.failAccounts) throw new BankProviderError("unavailable", "accounts/get 超时", 502);
      return [
      {
        providerAccountId: "acc_1",
        institutionName: "Bank of America",
        name: "Card",
        type: "credit",
        subtype: "credit card",
        lastFour: "4321",
        currency: "USD",
        ledgerKind: "credit_card" as const,
      },
    ];
    },
    fetchChanges: async () => {
      if (failSync) {
        failSync = false;
        throw new BankProviderError("reconnect", "ITEM_LOGIN_REQUIRED（需要重新登录）", 400, "ITEM_LOGIN_REQUIRED");
      }
      return {
        added: [row("txn_1", -500), row("txn_2", -700)].map((r) => ({ providerAccountId: "acc_1", row: r })),
        modified: [],
        removed: [],
        accounts: null,
        nextCursor: "c1",
      };
    },
    disconnect: async () => {
      p.disconnected++;
    },
  } satisfies BankProvider & Record<string, unknown>;
  return p;
}

async function setup(cfg: CoreBankConfig = configured, provider: BankProvider | null = fakeProvider()) {
  const db = await testDb();
  await seed(db);
  return { db, app: createApi({ getDb: () => db, bank: { config: () => cfg, provider: () => provider } }) };
}

const post = (json?: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: json === undefined ? undefined : JSON.stringify(json),
});

const del_ = (confirm?: unknown) => ({
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: confirm === undefined ? undefined : JSON.stringify({ confirm }),
});

describe("/api/bank", () => {
  it("config reports missing env vars and never returns secrets", async () => {
    const cfg = plaidConfig({});
    const { app } = await setup(cfg, null);
    const body = BankConfig.parse(await (await app.request("/api/bank/config")).json());
    expect(body).toEqual({
      provider: "plaid",
      configured: false,
      defaultEnvironment: "sandbox",
      environments: [],
      missing: ["PLAID_CLIENT_ID", "PLAID_SECRET_PRODUCTION / PLAID_SECRET_SANDBOX"],
    });

    const both = plaidConfig({ PLAID_CLIENT_ID: "cid_visible_nowhere", PLAID_SECRET_SANDBOX: "sb_visible_nowhere", PLAID_SECRET_PRODUCTION: "pr_visible_nowhere" });
    const res = await (await setup(both, fakeProvider())).app.request("/api/bank/config");
    const text = await res.text();
    expect(BankConfig.parse(JSON.parse(text))).toMatchObject({ configured: true, defaultEnvironment: "production", environments: ["production", "sandbox"] });
    expect(text).not.toContain("visible_nowhere");

    const sync = await app.request("/api/bank/connections/1/sync", { method: "POST" });
    expect(sync.status).toBe(409);
    expect(((await sync.json()) as { code: string }).code).toBe("bank_not_configured");
    expect((await app.request("/api/bank/link-token", post())).status).toBe(409);
  });

  it("link token, exchange with first sync, update-mode token, sync, reconnect error, disconnect", async () => {
    const provider = fakeProvider();
    const { app } = await setup(configured, provider);

    const lt = LinkTokenResult.parse(await (await app.request("/api/bank/link-token", post())).json());
    expect(lt.linkToken).toBe("link-sandbox-1");
    expect(provider.linkCalls[0]).toEqual({ clientUserId: "1", environment: "sandbox", kind: "bank" });

    expect((await app.request("/api/bank/exchange", post({}))).status).toBe(400);
    expect((await app.request("/api/bank/exchange", post({ public_token: "bad" }))).status).toBe(502);

    const res = await app.request(
      "/api/bank/exchange",
      post({ public_token: "public-sandbox-ok", institution: { name: "Bank of America", institution_id: "ins_127989" } }),
    );
    expect(res.status).toBe(200);
    const out = EnrollmentResult.parse(await res.json());
    expect(out.connection).toMatchObject({ provider: "plaid", environment: "sandbox", institutionName: "Bank of America" });
    expect(out.connection.accounts).toHaveLength(1);
    expect(out.sync?.inserted).toBe(2);
    expect(JSON.stringify(out)).not.toContain("access-sandbox-secret");

    const list = BankConnectionList.parse(await (await app.request("/api/bank/connections")).json());
    expect(list.connections[0]!.lastSyncedAt).not.toBeNull();
    expect(JSON.stringify(list)).not.toContain("access-sandbox-secret");

    const id = out.connection.id;
    await app.request("/api/bank/link-token", post({ connectionId: id }));
    expect(provider.linkCalls[1]).toEqual({ clientUserId: "1", accessToken: "access-sandbox-secret", environment: "sandbox", kind: "bank" });
    expect((await app.request("/api/bank/link-token", post({ connectionId: 999 }))).status).toBe(404);

    const again = BankSyncResult.parse(await (await app.request(`/api/bank/connections/${id}/sync`, { method: "POST" })).json());
    expect(again).toMatchObject({ inserted: 0, skippedDup: 2, modified: 0, removed: 0 });

    provider.failNextSync();
    const broken = await app.request(`/api/bank/connections/${id}/sync`, { method: "POST" });
    expect(broken.status).toBe(409);
    expect(((await broken.json()) as { code: string }).code).toBe("bank_provider_reconnect");
    const errored = BankConnectionList.parse(await (await app.request("/api/bank/connections")).json()).connections[0]!;
    expect(errored.status).toBe("error");

    const del = await app.request(`/api/bank/connections/${id}`, del_("Bank of America"));
    expect(del.status).toBe(200);
    expect(provider.disconnected).toBe(1);
    const after = await app.request(`/api/bank/connections/${id}/sync`, { method: "POST" });
    expect(after.status).toBe(409);
    expect((await app.request("/api/bank/connections/999/sync", { method: "POST" })).status).toBe(404);
  });

  it("DELETE needs the exact institution name in the body; pause / resume never call Plaid", async () => {
    const provider = fakeProvider();
    const { db, app } = await setup(configured, provider);
    await app.request("/api/bank/exchange", post({ public_token: "public-sandbox-ok", institution: { name: "Bank of America" } }));
    const before = await db.select().from(bankConnections);

    for (const req of [
      { method: "DELETE" },
      del_(),
      { ...del_(), body: "not json" },
      { ...del_(), body: JSON.stringify({}) },
      del_(""),
      del_("bank of america"),
      del_("Bank of Americaa"),
      del_("BoA"),
      del_(1),
    ]) {
      const res = await app.request("/api/bank/connections/1", req);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bank_disconnect_confirm", params: { confirm: "Bank of America" } });
    }
    expect((await app.request("/api/bank/connections/999", del_("Bank of America"))).status).toBe(404);
    expect(await db.select().from(bankConnections)).toEqual(before);
    expect(provider.disconnected).toBe(0);

    const paused = await app.request("/api/bank/connections/1/pause", post());
    expect(BankConnectionView.parse(await paused.json()).status).toBe("paused");
    const sync = await app.request("/api/bank/connections/1/sync", post());
    expect(sync.status).toBe(409);
    expect(await sync.json()).toMatchObject({ code: "bank_connection_paused", error: expect.stringContaining("paused") });
    expect(BankConnectionView.parse(await (await app.request("/api/bank/connections/1/resume", post())).json()).status).toBe("active");
    expect((await app.request("/api/bank/connections/1/sync", post())).status).toBe(200);
    expect((await app.request("/api/bank/connections/999/pause", post())).status).toBe(404);
    expect(provider.disconnected).toBe(0);

    const ok = await app.request("/api/bank/connections/1", del_("  Bank of America "));
    expect(ok.status).toBe(200);
    expect(BankConnectionView.parse(await ok.json()).status).toBe("disconnected");
    expect(provider.disconnected).toBe(1);
    expect((await app.request("/api/bank/connections/1/pause", post())).status).toBe(409);
  });

  it("link token and exchange accept only an available environment", async () => {
    const provider = fakeProvider(["production", "sandbox"]);
    const { app } = await setup({ ...configured, defaultEnvironment: "production", environments: ["production", "sandbox"] }, provider);
    expect((await app.request("/api/bank/link-token", post({ environment: "sandbox" }))).status).toBe(200);
    expect(provider.linkCalls.at(-1)).toEqual({ clientUserId: "1", environment: "sandbox", kind: "bank" });
    expect((await app.request("/api/bank/link-token", post())).status).toBe(200);
    expect(provider.linkCalls.at(-1)).toEqual({ clientUserId: "1", environment: "production", kind: "bank" });
    expect((await app.request("/api/bank/link-token", post({ environment: "development" }))).status).toBe(400);

    const sandboxOnly = fakeProvider(["sandbox"]);
    const one = (await setup(configured, sandboxOnly)).app;
    const bad = await one.request("/api/bank/link-token", post({ environment: "production" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("PLAID_SECRET_PRODUCTION");
    expect(sandboxOnly.linkCalls).toHaveLength(0);
    expect((await one.request("/api/bank/exchange", post({ public_token: "public-sandbox-ok", environment: "production" }))).status).toBe(400);
    expect((await one.request("/api/bank/exchange", post({ public_token: "public-sandbox-ok", environment: "sandbox" }))).status).toBe(200);
  });

  it("link-exit logs one line and stores nothing", async () => {
    const db = await testDb();
    await seed(db);
    const lines: string[] = [];
    const app = createApi({ getDb: () => db, bank: { config: () => configured, provider: () => fakeProvider(), log: (l) => lines.push(l) } });
    const ok = await app.request(
      "/api/bank/link-exit",
      post({
        kind: "exit",
        errorCode: "INSTITUTION_REGISTRATION_REQUIRED",
        errorMessage: "registration required",
        institution: "Bank of America",
        status: "requires_oauth",
        linkSessionId: "sess_1",
      }),
    );
    expect(ok.status).toBe(200);
    expect(lines).toEqual(["[yomi] Plaid Link exit: INSTITUTION_REGISTRATION_REQUIRED Bank of America requires_oauth sess_1 (registration required)"]);
    expect((await app.request("/api/bank/link-exit", post({ kind: "nope" }))).status).toBe(400);
    expect(BankConnectionList.parse(await (await app.request("/api/bank/connections")).json()).connections).toEqual([]);
  });

  it("exchange: stores the login even when accounts/get fails, and a retried POST reuses it", async () => {
    const provider = fakeProvider();
    provider.failAccounts = true;
    const { app, db } = await setup(configured, provider);
    const body = { public_token: "public-sandbox-ok", institution: { name: "Bank of America" } };
    const res = await app.request("/api/bank/exchange", post(body));
    expect(res.status).toBe(200);
    const out = EnrollmentResult.parse(await res.json());
    expect(out).toMatchObject({ sync: null, syncError: "accounts/get 超时", connection: { status: "error", institutionName: "Bank of America" } });
    expect((await db.select().from(bankConnections).limit(1))[0]!.accessToken).toBe("access-sandbox-secret");

    const retry = EnrollmentResult.parse(await (await app.request("/api/bank/exchange", post(body))).json());
    expect(retry.connection.id).toBe(out.connection.id);
    expect(provider.exchanges).toBe(1);
    expect(await db.select().from(bankConnections)).toHaveLength(1);
  });

  it("link-sessions/recover saves an Item whose public token the browser never delivered, once", async () => {
    const provider = fakeProvider();
    const lines: string[] = [];
    const db = await testDb();
    await seed(db);
    const app = createApi({ getDb: () => db, bank: { config: () => configured, provider: () => provider, log: (l) => lines.push(l) } });
    const lt = LinkTokenResult.parse(await (await app.request("/api/bank/link-token", post({}))).json());
    expect(lt.sessionId).toBeGreaterThan(0);
    provider.linkSessions.set(lt.linkToken, [
      { linkSessionId: "sess_x", finished: true, exitStatus: null, items: [{ publicToken: "public-sandbox-ok", institutionName: "Bank of America" }] },
    ]);
    const res = await app.request("/api/bank/link-sessions/recover", post({ sessionId: lt.sessionId, linkSessionId: "sess_x" }));
    expect(res.status).toBe(200);
    const out = LinkRecoveryResult.parse(await res.json());
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({ institutionName: "Bank of America", sync: { inserted: 2 } });
    expect(out.sessions[0]).toMatchObject({ status: "recovered", linkSessionId: "sess_x" });
    expect(JSON.stringify(out)).not.toContain("access-sandbox-secret");
    expect(lines.join()).toContain("Recovered an unfinished bank connection: Bank of America");

    const again = LinkRecoveryResult.parse(await (await app.request("/api/bank/link-sessions/recover", post())).json());
    expect(again).toEqual({ sessions: [], recovered: [] });
    expect(provider.exchanges).toBe(1);
    expect(await db.select().from(bankConnections)).toHaveLength(1);
    expect((await app.request("/api/bank/link-sessions/recover", post({ sessionId: "x" }))).status).toBe(400);
  });

  it("a missing YOMI_SECRET_KEY with encrypted tokens answers 409 with the key error and changes nothing", async () => {
    const provider = fakeProvider();
    const { db, app } = await setup(configured, provider);
    vi.stubEnv("YOMI_SECRET_KEY", randomBytes(32).toString("base64"));
    try {
      await app.request("/api/bank/exchange", post({ public_token: "public-sandbox-ok", institution: { name: "Bank of America" } }));
      expect((await db.select().from(bankConnections).limit(1))[0]!.accessToken.startsWith("enc:v1:")).toBe(true);
      vi.stubEnv("YOMI_SECRET_KEY", "");
      const before = await db.select().from(bankConnections);
      for (const res of [
        await app.request("/api/bank/connections/1/sync", { method: "POST" }),
        await app.request("/api/bank/link-sessions/recover", post()),
        await app.request("/api/bank/link-token", post()),
        await app.request("/api/bank/connections/1", del_("Bank of America")),
      ]) {
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: SECRET_UNAVAILABLE_MESSAGE, code: "bank_secret_missing", params: {} });
      }
      expect(await db.select().from(bankConnections)).toEqual(before);
      expect(provider.disconnected).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
