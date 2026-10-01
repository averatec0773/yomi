import { readFileSync } from "node:fs";
import { InvestAccountList, InvestConfig, InvestOverview, InvestSyncResult, LinkTokenResult } from "@yomi/contracts";
import { type BankConfig, type BankProvider, InvestError, seed } from "@yomi/core";
import { plaidLinkSessions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { mapFlexStatement } from "@yomi/importers";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

const xml = readFileSync(new URL("../../importers/test/fixtures/ibkr/flex-activity.xml", import.meta.url), "utf8");

async function setup(opts: { ibkr?: boolean; fxDown?: boolean; ibkrError?: InvestError } = {}) {
  const db = await testDb();
  const ranges: unknown[] = [];
  await seed(db);
  const linkCalls: { kind?: string }[] = [];
  const provider = {
    id: "plaid",
    source: "plaid",
    environments: ["sandbox"],
    defaultEnvironment: "sandbox",
    tokenEnvironment: () => "sandbox",
    createLinkToken: async (o: { kind?: string }) => {
      linkCalls.push(o);
      return { linkToken: `link-sandbox-${linkCalls.length}`, expiration: "x" };
    },
  } as unknown as BankProvider;
  const config: BankConfig = { provider: "plaid", configured: true, defaultEnvironment: "sandbox", environments: ["sandbox"], missing: [] };
  const fxFetch = (async () => {
    if (opts.fxDown) throw new Error("offline");
    return new Response(JSON.stringify([{ date: "2026-09-29", base: "USD", quote: "HKD", rate: 7.846 }, { date: "2026-09-29", base: "USD", quote: "CNY", rate: 6.7034 }]));
  }) as typeof fetch;
  const app = createApi({
    getDb: () => db,
    bank: { config: () => config, provider: () => provider },
    invest: {
      ibkr: () =>
        opts.ibkr === false ? null : (
          {
            fetchStatement: async (range?: unknown) => {
              ranges.push(range);
              if (opts.ibkrError) throw opts.ibkrError;
              return mapFlexStatement(xml);
            },
          }
        ),
      ibkrConfig: () => (opts.ibkr === false ? { configured: false, missing: ["IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID"] } : { configured: true, missing: [] }),
      fetch: fxFetch,
      now: () => new Date("2026-09-29T23:00:00Z"),
    },
  });
  const req = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, app, req, linkCalls, ranges };
}

describe("/api/invest", () => {
  it("reports config without secrets", async () => {
    const { req } = await setup({ ibkr: false });
    const res = await req("GET", "/invest/config");
    const body = InvestConfig.parse(await res.json());
    expect(body).toEqual({ ibkr: { configured: false, missing: ["IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID"] }, plaid: { configured: true, brokerageConnections: 0 }, fx: { source: "frankfurter" } });
  });

  it("syncs IBKR, then lists accounts and the overview with a converted total", async () => {
    const { req } = await setup();
    const sync = InvestSyncResult.parse(await (await req("POST", "/invest/sync", { provider: "ibkr" })).json());
    expect(sync.results[0]).toMatchObject({ provider: "ibkr", asOf: "2026-09-28", positions: 4, cashBalances: 2, transactionsNew: 5 });
    // 19:00 New York on Tuesday 09-29: Tuesday's statement is expected, the fixture is Monday's.
    expect([sync.results[0]!.stale, sync.results[0]!.expectedAsOf]).toEqual([true, "2026-09-29"]);

    const accts = InvestAccountList.parse(await (await req("GET", "/invest/accounts")).json());
    expect(accts.accounts).toEqual([{ id: 1, provider: "ibkr", name: "Test IBKR", currency: "USD", bankConnectionId: null, latestAsOf: "2026-09-28" }]);

    const o = InvestOverview.parse(await (await req("GET", "/invest/overview?currency=CNY")).json());
    expect(o.asOf).toBe("2026-09-28");
    expect(o.accounts[0]!.positions.length).toBe(6);
    expect(o.converted).toMatchObject({ currency: "CNY", fx: { date: "2026-09-29", base: "USD" } });
    expect(o.fxError).toBeNull();
    const plain = InvestOverview.parse(await (await req("GET", "/invest/overview")).json());
    expect(plain.converted).toBeNull();
  });

  it("returns the overview without a converted total when FX is unavailable", async () => {
    const { req } = await setup({ fxDown: true });
    await req("POST", "/invest/sync", { provider: "ibkr" });
    const o = InvestOverview.parse(await (await req("GET", "/invest/overview?currency=CNY")).json());
    expect([o.converted, o.fxError?.code, o.totals.length]).toEqual([null, "invest_fx_unavailable", 2]);
  });

  it("maps errors to stable codes", async () => {
    const off = await setup({ ibkr: false });
    const r1 = await off.req("POST", "/invest/sync", { provider: "ibkr" });
    expect([r1.status, ((await r1.json()) as { code: string }).code]).toEqual([409, "invest_ibkr_not_configured"]);

    const expired = await setup({ ibkrError: new InvestError("invest_ibkr_token_expired", "Token has expired.") });
    const r2 = await expired.req("POST", "/invest/sync", { provider: "ibkr" });
    expect([r2.status, ((await r2.json()) as { code: string }).code]).toEqual([409, "invest_ibkr_token_expired"]);
    const all = InvestSyncResult.parse(await (await expired.req("POST", "/invest/sync", {})).json());
    expect(all.errors.map((e) => e.code)).toEqual(["invest_ibkr_token_expired"]);

    const timeout = await setup({ ibkrError: new InvestError("invest_flex_in_progress_timeout", "not ready") });
    expect((await timeout.req("POST", "/invest/sync", { provider: "ibkr" })).status).toBe(504);

    const bad = await off.req("GET", "/invest/overview?asOf=yesterday");
    expect([bad.status, ((await bad.json()) as { code: string }).code]).toEqual([400, "validation_failed"]);
  });
});

describe("IBKR date windows", () => {
  const codeOf = async (r: Response) => [r.status, ((await r.json()) as { code: string; params?: Record<string, unknown> })] as const;

  it("backfills 365 days on the first sync, then asks from a week before the last statement", async () => {
    const { req, ranges } = await setup();
    const first = InvestSyncResult.parse(await (await req("POST", "/invest/sync", { provider: "ibkr" })).json());
    expect(first.results[0]!.range).toEqual({ from: "2025-09-30", to: "2026-09-29" });
    await req("POST", "/invest/sync", { provider: "ibkr" });
    expect(ranges).toEqual([
      { from: "2025-09-30", to: "2026-09-29" },
      { from: "2026-09-21", to: "2026-09-29" },
    ]);
  });

  it("POST /invest/ibkr/history validates days, pulls that window and refuses a second pull within 10 minutes", async () => {
    const { req, ranges } = await setup();
    for (const body of [{ days: 0 }, { days: 366 }, { days: 1.5 }, { days: "30" }, {}]) {
      const [status, err] = await codeOf(await req("POST", "/invest/ibkr/history", body));
      expect([status, err.code, err.params]).toEqual([400, "invest_ibkr_history_days_invalid", { min: 1, max: 365 }]);
    }
    expect(ranges).toEqual([]);

    const ok = InvestSyncResult.parse(await (await req("POST", "/invest/ibkr/history", { days: 30 })).json());
    expect(ok.results[0]).toMatchObject({ provider: "ibkr", range: { from: "2026-08-31", to: "2026-09-29" }, transactionsNew: 5 });
    expect(ranges).toEqual([{ from: "2026-08-31", to: "2026-09-29" }]);

    const [status, err] = await codeOf(await req("POST", "/invest/ibkr/history", { days: 365 }));
    expect([status, err.code, err.params]).toEqual([429, "invest_ibkr_pull_too_soon", { minutes: 10 }]);
    expect(ranges.length).toBe(1);
  });

  it("POST /invest/ibkr/history reports a failed pull, then waits 30 minutes; not configured is 409", async () => {
    const expired = await setup({ ibkrError: new InvestError("invest_ibkr_token_expired", "Token has expired.") });
    const [s1, e1] = await codeOf(await expired.req("POST", "/invest/ibkr/history", { days: 365 }));
    expect([s1, e1.code]).toEqual([409, "invest_ibkr_token_expired"]);
    const [s2, e2] = await codeOf(await expired.req("POST", "/invest/ibkr/history", { days: 365 }));
    expect([s2, e2.code, e2.params]).toEqual([429, "invest_ibkr_pull_backoff", { minutes: 30 }]);

    const off = await setup({ ibkr: false });
    const [s3, e3] = await codeOf(await off.req("POST", "/invest/ibkr/history", { days: 10 }));
    expect([s3, e3.code]).toEqual([409, "invest_ibkr_not_configured"]);
  });
});

describe("POST /api/bank/link-token purpose", () => {
  it("opens a brokerage Link session with purpose brokerage, a bank one by default", async () => {
    const { req, linkCalls, db } = await setup();
    LinkTokenResult.parse(await (await req("POST", "/bank/link-token", { purpose: "brokerage" })).json());
    LinkTokenResult.parse(await (await req("POST", "/bank/link-token")).json());
    expect(linkCalls.map((c) => c.kind)).toEqual(["brokerage", "bank"]);
    expect((await db.select().from(plaidLinkSessions)).map((s) => s.kind)).toEqual(["brokerage", "bank"]);
  });
});
