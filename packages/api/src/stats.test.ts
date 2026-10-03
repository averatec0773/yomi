import { ApiError, StatsResponse, Target, TransactionPage } from "@yomi/contracts";
import { getCurrentUser, seed } from "@yomi/core";
import { transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

async function setup() {
  const db = await testDb();
  await seed(db);
  let n = 0;
  const add = async (occurredAt: string, amountMinor: number, currency = "CNY") =>
    await db
      .insert(transactions)
      .values({ userId: getCurrentUser().id, occurredAt: `${occurredAt}T12:00:00+08:00`, amountMinor, currency, kind: "expense", source: "alipay", dedupKey: `k${++n}` });
  await add("2026-07-10", -1000);
  await add("2026-08-10", -2000);
  await add("2026-09-10", -3000);
  await add("2026-09-11", -500, "USD");
  await add("2026-06-10", -4000);
  const app = createApi({ getDb: () => db, today: () => "2026-09-29" });
  return { db, app };
}

describe("GET /api/stats", () => {
  it("resolves presets against today", async () => {
    const { app } = await setup();
    const res = await app.request("/api/stats?preset=last_3_months");
    expect(res.status).toBe(200);
    const body = StatsResponse.parse(await res.json());
    expect(body).toMatchObject({ preset: "last_3_months", from: "2026-07-01", to: "2026-09-30", inProgress: true, days: 91 });
    expect(body.previous).toMatchObject({ from: "2026-04-01", to: "2026-06-30" });
    const cny = body.currencies.find((c) => c.currency === "CNY")!;
    expect(cny).toMatchObject({ spendingMinor: 6000, previous: { spendingMinor: 4000 } });
    expect(cny.monthly!.map((m) => [m.month, m.spendingMinor, m.partial])).toEqual([
      ["2026-07", 1000, false],
      ["2026-08", 2000, false],
      ["2026-09", 3000, true],
    ]);

    const def = StatsResponse.parse(await (await app.request("/api/stats")).json());
    expect(def).toMatchObject({ preset: "this_month", from: "2026-09-01", to: "2026-09-30", month: "2026-09" });
  });

  it("accepts a custom range and names a matching preset", async () => {
    const { app } = await setup();
    const custom = StatsResponse.parse(await (await app.request("/api/stats?from=2026-08-01&to=2026-09-15")).json());
    expect(custom).toMatchObject({ preset: "custom", lengthDays: 46, previous: { from: "2026-06-16", to: "2026-07-31" } });
    expect(custom.currencies.map((c) => [c.currency, c.spendingMinor])).toEqual([
      ["CNY", 5000],
      ["USD", 500],
    ]);
    const named = StatsResponse.parse(await (await app.request("/api/stats?preset=custom&from=2026-08-01&to=2026-08-31")).json());
    expect(named.preset).toBe("last_month");
  });

  it("rejects bad queries with 400", async () => {
    const { app } = await setup();
    for (const q of [
      "preset=next_year",
      "from=2026-09-01",
      "from=2026-09-30&to=2026-09-01",
      "from=2026-02-30&to=2026-03-01",
      "preset=this_year&from=2026-01-01&to=2026-01-31",
      "preset=custom",
      "from=2020-01-01&to=2026-01-01",
      "month=2026-09",
    ]) {
      const res = await app.request(`/api/stats?${q}`);
      expect(res.status, q).toBe(400);
      expect(ApiError.parse(await res.json()).code, q).toBe(q.startsWith("from=2020") ? "range_too_long" : "validation_failed");
    }
  });
});

describe("PUT /api/targets", () => {
  const put = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("sets the default and a month's own target, which stats then compare against", async () => {
    const { app } = await setup();
    const def = await app.request("/api/targets", put({ month: null, amountMinor: 10000, currency: "CNY" }));
    expect(def.status).toBe(200);
    expect(Target.parse(await def.json())).toMatchObject({ month: null, amountMinor: 10000, currency: "CNY" });
    let sep = StatsResponse.parse(await (await app.request("/api/stats?preset=this_month")).json());
    expect(sep.currencies.find((c) => c.currency === "CNY")!.target).toEqual({ amountMinor: 10000, currency: "CNY", remainingMinor: 7000, monthSpecific: false });

    expect((await app.request("/api/targets", put({ month: "2026-09", amountMinor: 2000, currency: "CNY" }))).status).toBe(200);
    sep = StatsResponse.parse(await (await app.request("/api/stats?preset=this_month")).json());
    expect(sep.currencies.find((c) => c.currency === "CNY")!.target).toMatchObject({ remainingMinor: -1000, monthSpecific: true });
    const aug = StatsResponse.parse(await (await app.request("/api/stats?preset=last_month")).json());
    expect(aug.currencies.find((c) => c.currency === "CNY")!.target).toMatchObject({ amountMinor: 10000, monthSpecific: false });
  });

  it("rejects bodies that do not match the contract with 400", async () => {
    const { app } = await setup();
    for (const body of [
      { month: null, amountMinor: -1, currency: "CNY" },
      { month: "2026-9", amountMinor: 100, currency: "CNY" },
      { month: null, amountMinor: 1.5, currency: "CNY" },
      { month: null, amountMinor: 100, currency: "yuan" },
      { month: null, amountMinor: 100, currency: "CNY", extra: true },
      { amountMinor: 100, currency: "CNY" },
    ]) {
      const res = await app.request("/api/targets", put(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(ApiError.parse(await res.json()).code).toBe("validation_failed");
    }
  });
});

describe("range filters on transactions and export", () => {
  it("GET /api/transactions?from&to filters and returns range totals", async () => {
    const { app } = await setup();
    const page = TransactionPage.parse(await (await app.request("/api/transactions?from=2026-08-01&to=2026-09-10")).json());
    expect(page.total).toBe(2);
    expect(page.totals).toMatchObject([{ currency: "CNY", count: 2, spendingMinor: 5000 }]);
    expect((await app.request("/api/transactions?from=2026-13-01")).status).toBe(400);
  });

  it("GET /api/export/transactions.csv?from&to exports the range", async () => {
    const { app } = await setup();
    const res = await app.request("/api/export/transactions.csv?from=2026-07-01&to=2026-08-31");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("yomi-transactions-2026-07-01_2026-08-31.csv");
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines.slice(1).map((l) => l.slice(0, 10))).toEqual(["2026-07-10", "2026-08-10"]);
    expect((await app.request("/api/export/transactions.csv?from=2026-07-01")).status).toBe(400);
    expect((await app.request("/api/export/transactions.csv?from=2026-09-01&to=2026-07-01")).status).toBe(400);
  });
});
