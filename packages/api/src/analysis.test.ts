import { AnalysisReport, ApiError, FreshnessResponse, IncomeSummary } from "@yomi/contracts";
import { getCurrentUser, seed, setTimeZone } from "@yomi/core";
import { importBatches, transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

async function setup() {
  const db = await testDb();
  await seed(db);
  const user = getCurrentUser();
  await setTimeZone(db, user, "Asia/Shanghai");
  let n = 0;
  const add = async (day: string, amountMinor: number, source: "alipay" | "wechat" = "alipay", currency = "CNY") =>
    await db.insert(transactions).values({
      userId: user.id,
      occurredAt: `${day}T12:00:00+08:00`,
      occurredOn: day,
      amountMinor,
      currency,
      kind: "expense",
      source,
      merchant: "Maple Noodles",
      dedupKey: `k${++n}`,
    });
  await add("2026-09-29", -1800);
  await add("2026-09-28", -1200);
  await add("2026-09-21", -900);
  await add("2026-09-24", -700, "wechat");
  await add("2026-08-15", -5000);
  await db.insert(importBatches).values([
    { userId: user.id, source: "alipay", fileName: "a.csv", fileHash: "a", periodEnd: "2026-09-29" },
    { userId: user.id, source: "wechat", fileName: "w.xlsx", fileHash: "w", periodEnd: "2026-09-24" },
  ]);
  const app = createApi({ getDb: () => db, today: () => "2026-09-30" });
  return { app };
}

const get = async (app: Awaited<ReturnType<typeof setup>>["app"], q: string) => {
  const res = await app.request(`/api/analysis${q}`);
  expect(res.status, q).toBe(200);
  return AnalysisReport.parse(await res.json());
};

describe("GET /api/analysis", () => {
  it("defaults to this month and resolves period + date against the pinned today", async () => {
    const { app } = await setup();
    expect(await get(app, "")).toMatchObject({ kind: "month", from: "2026-09-01", to: "2026-09-30", today: "2026-09-30", inProgress: true });

    const day = await get(app, "?period=day");
    expect(day).toMatchObject({ kind: "day", from: "2026-09-29", to: "2026-09-29", inProgress: false, arrivals: [] });
    expect(day.currencies.map((c) => [c.currency, c.spendingMinor, c.partialSources])).toEqual([["CNY", 1800, ["wechat"]]]);

    const week = await get(app, "?period=week&date=2026-09-24");
    expect(week).toMatchObject({ kind: "week", from: "2026-09-21", to: "2026-09-27", inProgress: false });
    // WeChat reaches Sep 24 only, so that week is partial in CNY.
    expect(week.partial).toEqual({ CNY: ["wechat"] });
    expect(week.currencies[0]).toMatchObject({ spendingMinor: 1600, dayRows: null });

    expect(await get(app, "?period=week")).toMatchObject({ from: "2026-09-28", to: "2026-10-04", inProgress: true, days: 3 });
    expect(await get(app, "?preset=last_month")).toMatchObject({ kind: "month", from: "2026-08-01", to: "2026-08-31", inProgress: false });
    expect(await get(app, "?period=year")).toMatchObject({ kind: "year", from: "2026-01-01", to: "2026-12-31", typicalRanges: [{ from: "2023-01-01" }, {}, {}] });
    expect(await get(app, "?preset=today")).toMatchObject({ kind: "day", from: "2026-09-30", inProgress: true });
    expect(await get(app, "?from=2026-09-05&to=2026-09-20")).toMatchObject({ kind: "range", typicalRanges: [] });
  });

  it("rejects bad queries with 400", async () => {
    const { app } = await setup();
    for (const q of ["period=quarter", "date=2026-09-01", "period=day&preset=today", "preset=today&from=2026-09-01&to=2026-09-02", "from=2026-09-01", "from=2026-09-30&to=2026-09-01", "period=day&date=2026-02-30", "month=2026-09"]) {
      const res = await app.request(`/api/analysis?${q}`);
      expect(res.status, q).toBe(400);
      expect(ApiError.parse(await res.json()).code, q).toBe("validation_failed");
    }
    const long = await app.request("/api/analysis?from=2020-01-01&to=2026-01-01");
    expect(long.status).toBe(400);
    expect(ApiError.parse(await long.json()).code).toBe("range_too_long");
  });
});

describe("GET /api/analysis/income", () => {
  it("answers the cash flow per currency for the same selections, one currency on request", async () => {
    const { app } = await setup();
    const res = await app.request("/api/analysis/income?period=month&date=2026-09-10");
    expect(res.status).toBe(200);
    const body = IncomeSummary.parse(await res.json());
    expect(body).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(body.currencies).toEqual([
      { currency: "CNY", incomeMinor: 0, incomeNotCountedMinor: 0, spendingMinor: 4600, netMinor: -4600, savingsRateBp: null, byCategory: [], transfersInMinor: 0, repaymentsMinor: 0 },
    ]);
    expect(IncomeSummary.parse(await (await app.request("/api/analysis/income?preset=this_month&currency=usd")).json()).currencies).toEqual([]);
    expect((await app.request("/api/analysis/income?period=day&preset=today")).status).toBe(400);
  });
});

describe("GET /api/analysis/freshness", () => {
  it("lists every source with its reach and state", async () => {
    const { app } = await setup();
    const res = await app.request("/api/analysis/freshness");
    expect(res.status).toBe(200);
    const body = FreshnessResponse.parse(await res.json());
    expect(body.today).toBe("2026-09-30");
    expect(body.sources.map((s) => [s.key, s.through, s.state, s.exportReminder])).toEqual([
      ["alipay", "2026-09-29", "current", false],
      ["wechat", "2026-09-24", "behind", false],
    ]);
  });
});
