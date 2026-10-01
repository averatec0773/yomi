import { AssetsSyncResult, NetWorthView, StartingBalanceResult } from "@yomi/contracts";
import { seed, upsertBalanceSnapshot, getCurrentUser } from "@yomi/core";
import { accounts } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

async function setup() {
  const db = await testDb();
  await seed(db);
  const user = getCurrentUser();
  const wallet = (
    await db.insert(accounts).values({ userId: user.id, name: "支付宝余额", kind: "wallet", institution: "支付宝", currency: "CNY" }).returning({ id: accounts.id })
  )[0]!.id;
  const card = (
    await db
      .insert(accounts)
      .values({ userId: user.id, name: "工商银行信用卡 3141", kind: "credit_card", institution: "工商银行", last4: "3141", currency: "USD" })
      .returning({ id: accounts.id })
  )[0]!.id;
  await upsertBalanceSnapshot(db, user, { accountId: card, asOf: "2026-09-24", balanceMinor: -18324, currency: "USD", source: "statement" });
  const fxFetch = (async () => new Response(JSON.stringify([{ date: "2026-09-29", base: "USD", quote: "CNY", rate: 7.1 }]))) as unknown as typeof fetch;
  const app = createApi({
    getDb: () => db,
    bank: { provider: () => null },
    invest: { ibkr: () => null, fetch: fxFetch, now: () => new Date("2026-09-29T20:00:00Z") },
  });
  const req = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, req, wallet, card };
}

describe("/api/assets", () => {
  it("GET net-worth: per currency, converted with the stated rate, history for the range", async () => {
    const { req, wallet } = await setup();
    expect((await req("PUT", `/accounts/${wallet}/starting-balance`, { amountMinor: 71000, on: "2026-09-01" })).status).toBe(200);
    const res = await req("GET", "/assets/net-worth?asOf=2026-09-29&currency=USD&range=1m");
    expect(res.status).toBe(200);
    const n = NetWorthView.parse(await res.json());
    expect(n.currencies.map((c) => [c.currency, c.cashMinor, c.cardsMinor, c.totalMinor])).toEqual([
      ["CNY", 71000, 0, 71000],
      ["USD", 0, -18324, -18324],
    ]);
    expect(n.converted).toMatchObject({ currency: "USD", totalMinor: -18324 + 10000, fx: { date: "2026-09-29", rates: [{ from: "CNY", rate: "0.140845", inverse: "7.1" }] } });
    expect(n.series).toHaveLength(31);
    expect(n.series.at(-1)!.converted!.totalMinor).toBe(-8324);
    expect(n.accounts.find((a) => a.id === wallet)!.startingBalance).toEqual({ amountMinor: 71000, on: "2026-09-01" });

    const plain = NetWorthView.parse(await (await req("GET", "/assets/net-worth?asOf=2026-09-29")).json());
    expect([plain.range, plain.converted, plain.from]).toEqual(["3m", null, "2026-07-01"]);
    expect((await req("GET", "/assets/net-worth?range=2y")).status).toBe(400);
    expect((await req("GET", "/assets/net-worth?currency=usd")).status).toBe(400);
  });

  it("PUT starting-balance: sets, clears, validates", async () => {
    const { req, wallet } = await setup();
    const set = StartingBalanceResult.parse(await (await req("PUT", `/accounts/${wallet}/starting-balance`, { amountMinor: 120430, on: "2026-09-01" })).json());
    expect(set).toEqual({ id: wallet, startingBalance: { amountMinor: 120430, on: "2026-09-01" } });
    const cleared = StartingBalanceResult.parse(await (await req("PUT", `/accounts/${wallet}/starting-balance`, { clear: true })).json());
    expect(cleared.startingBalance).toBeNull();
    const bad = await req("PUT", `/accounts/${wallet}/starting-balance`, { amountMinor: 1.5, on: "2026-09-01" });
    expect([bad.status, ((await bad.json()) as { code: string }).code]).toEqual([400, "validation_failed"]);
    const missing = await req("PUT", "/accounts/999/starting-balance", { amountMinor: 1, on: "2026-09-01" });
    expect([missing.status, ((await missing.json()) as { code: string }).code]).toEqual([404, "assets_account_not_found"]);
  });

  it("POST sync without sources: nothing to pull, today's snapshots written", async () => {
    const { req } = await setup();
    const out = AssetsSyncResult.parse(await (await req("POST", "/assets/sync")).json());
    expect(out).toEqual({ bank: null, invest: { results: [], errors: [], skipped: ["ibkr", "plaid"] } });
  });
});
