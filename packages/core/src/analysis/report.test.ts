import { accounts, bankAccounts, bankConnections, type Db, importBatches } from "@yomi/db";
import type { InvestStatement } from "@yomi/importers";
import { describe, expect, it } from "vitest";
import { writeStatement } from "../invest/store";
import { addTx, catId, freshDb, user } from "../ledger/test-helpers";
import { rangeOverview } from "../stats/range";
import { analysisReport } from "./report";

// Fictional ledger in Asia/Shanghai (freshDb): a USD checking account through a Plaid login (synced on Sep 30, so
// it covers through Sep 29), Alipay complete through Sep 29 and WeChat only through Sep 24. "Today" is Sep 30.
const TODAY = "2026-09-30";
const NOW = new Date("2026-09-30T04:00:00Z");
const cn = (day: string, h = 12) => `${day}T${String(h).padStart(2, "0")}:00:00+08:00`;
const us = (day: string) => `${day}T12:00:00-05:00`;

async function ledger(): Promise<Db> {
  const db = await freshDb();
  const dining = await catId(db, "餐饮");
  const groceries = await catId(db, "买菜");
  const conn = (await db
    .insert(bankConnections)
    .values({ userId: user.id, provider: "plaid", kind: "bank", enrollmentId: "fixture-item", institutionName: "Pine Credit Union", accessToken: "", lastSyncedAt: "2026-09-30T01:00:00.000Z" })
    .returning())[0]!.id;
  const checking = (await db.insert(accounts).values({ userId: user.id, name: "Pine checking 5501", kind: "debit_card", last4: "5501", currency: "USD" }).returning())[0]!.id;
  await db.insert(bankAccounts).values({ userId: user.id, connectionId: conn, providerAccountId: "fixture-chk", accountId: checking, name: "Checking", type: "depository", lastFour: "5501", currency: "USD" });
  const usd = (day: string, minor: number, merchant: string, categoryId: number | null = dining, createdAt?: string) =>
    addTx(db, { amountMinor: -minor, currency: "USD", source: "plaid", accountId: checking, merchant, categoryId, occurredAt: us(day), ...(createdAt ? { createdAt } : {}) });

  // History since July: a cafe every week (~$6.50) and groceries every Saturday.
  for (let d = Date.UTC(2026, 6, 4); d <= Date.UTC(2026, 8, 26); d += 7 * 86_400_000) {
    const day = new Date(d).toISOString().slice(0, 10);
    await usd(day, 650, "Corner Cafe");
    await usd(day, 4000, "Green Grocer", groceries);
  }
  // Sep 29 (yesterday): the cafe at four times the usual, two more rows; written on Sep 29 Shanghai time.
  const arrived = "2026-09-29T03:00:00.000Z";
  await usd("2026-09-29", 2600, "Corner Cafe", dining, arrived);
  await usd("2026-09-29", 1200, "Aster Books", null, arrived);
  await usd("2026-09-29", 900, "Corner Cafe", dining, arrived);
  // Sep 28 to 30: dining well above typical.
  await usd("2026-09-28", 9000, "Harbor Grill");
  await usd("2026-09-30", 500, "Corner Cafe");

  await addTx(db, { amountMinor: -3800, source: "alipay", merchant: "Maple Noodles", occurredAt: cn("2026-09-29"), createdAt: arrived });
  await addTx(db, { amountMinor: -2500, source: "alipay", merchant: "Maple Noodles", occurredAt: cn("2026-08-29") });
  await addTx(db, { amountMinor: -1500, source: "wechat", merchant: "Lotus Tea", occurredAt: cn("2026-09-24") });
  await db.insert(importBatches).values([
    { userId: user.id, source: "alipay", fileName: "a.csv", fileHash: "a", periodStart: "2026-07-01", periodEnd: "2026-09-29" },
    { userId: user.id, source: "wechat", fileName: "w.xlsx", fileHash: "w", periodStart: "2026-07-01", periodEnd: "2026-09-24" },
  ]);
  return db;
}

const opts = { today: TODAY, env: {}, now: NOW };

describe("analysisReport", () => {
  it("day: rows, typical day, unusual, arrivals, market close, partial CNY and complete USD", async () => {
    const db = await ledger();
    const r = await analysisReport(db, user, { from: "2026-09-29", to: "2026-09-29" }, opts);
    expect(r).toMatchObject({ kind: "day", inProgress: false, future: false, days: 1, close: { marketDay: true, previousClose: "2026-09-28" } });
    expect(r.typicalRanges).toHaveLength(28);
    const usd = r.currencies.find((c) => c.currency === "USD")!;
    const cny = r.currencies.find((c) => c.currency === "CNY")!;
    expect(usd).toMatchObject({ spendingMinor: 4700, transactionCount: 3, partialSources: [] });
    expect(usd.dayRows!.map((d) => [d.merchant, d.minor])).toEqual([
      ["Corner Cafe", 2600],
      ["Aster Books", 1200],
      ["Corner Cafe", 900],
    ]);
    // 28 days before Sep 29: four Saturdays of $6.50 + $40 and the $90 grill on Sep 28.
    expect(usd.typical).toEqual({ periods: 28, perPeriodMinor: Math.round((4 * 4650 + 9000) / 28), dailyMinor: Math.round((4 * 4650 + 9000) / 28) });
    expect(usd.unusual).toEqual([expect.objectContaining({ kind: "larger_than_usual", merchant: "Corner Cafe", minor: 2600, usualMinor: 650 })]);
    expect(cny).toMatchObject({ spendingMinor: 3800, partialSources: ["wechat"] });
    // Top merchants are not a comparison: a partial currency still has them.
    expect(cny.topMerchants).toEqual([{ merchant: "Maple Noodles", minor: 3800, count: 1, share: 10000 }]);
    expect(r.partial).toEqual({ CNY: ["wechat"] });
    expect(r.arrivals).toEqual([
      { source: "plaid", count: 3 },
      { source: "alipay", count: 1 },
    ]);
    expect(r.freshness.map((f) => [f.key, f.state])).toEqual([
      [expect.stringMatching(/^plaid:\d+$/), "current"],
      ["alipay", "current"],
      ["wechat", "behind"],
    ]);
    expect(r.investments).toBeNull();
    expect(r.attention).toEqual([]);
  });

  it("week in progress: daily average over elapsed days, typical weeks, category shifts, top merchants", async () => {
    const db = await ledger();
    const r = await analysisReport(db, user, { from: "2026-09-28", to: "2026-10-04" }, opts);
    expect(r).toMatchObject({ kind: "week", inProgress: true, days: 3, lengthDays: 7, arrivals: null, close: null });
    const usd = r.currencies.find((c) => c.currency === "USD")!;
    expect(usd.spendingMinor).toBe(9000 + 2600 + 1200 + 900 + 500);
    expect(usd.typical).toEqual({ periods: 4, perPeriodMinor: 4650, dailyMinor: Math.round(4650 / 7) });
    expect(usd.topMerchants[0]).toEqual({ merchant: "Harbor Grill", minor: 9000, count: 1, share: Math.round((9000 * 10000) / 14200) });
    // Dining: 13000 against 650 a week scaled to 3 days (279).
    expect(usd.categoryShifts[0]).toMatchObject({ name: "餐饮", currentMinor: 13000, typicalMinor: 279 });
    expect(usd.dayRows).toBeNull();
    // Harbor Grill and Aster Books are new (history since July); the cafe is not.
    expect(usd.newMerchants.map((m) => m.merchant)).toEqual(["Harbor Grill", "Aster Books"]);
  });

  it("month: the same totals as Stats", async () => {
    const db = await ledger();
    const range = { from: "2026-08-01", to: "2026-08-31" };
    const r = await analysisReport(db, user, range, opts);
    const stats = await rangeOverview(db, user, range, { today: TODAY });
    expect(r.kind).toBe("month");
    expect(r.currencies.map((c) => [c.currency, c.spendingMinor, c.transactionCount])).toEqual(stats.currencies.map((c) => [c.currency, c.spendingMinor, c.transactionCount]));
    // Only July before August: not enough history for a typical month.
    expect(r.currencies.every((c) => c.typical === null)).toBe(true);
  });

  it("source totals add up to the summary numbers; a linked pair counts once, on the kept row", async () => {
    const db = await ledger();
    const checking = (await db.select({ id: bankAccounts.accountId }).from(bankAccounts))[0]!.id!;
    // A card charge linked to the Alipay payment it funded: the ledger keeps the Alipay row.
    const wallet = await addTx(db, { amountMinor: -2000, currency: "USD", source: "alipay", merchant: "Pine Market", occurredAt: cn("2026-09-15") });
    await addTx(db, { amountMinor: -2000, currency: "USD", source: "plaid", accountId: checking, merchant: "ALIPAY PINE MARKET", occurredAt: us("2026-09-15"), duplicateOfId: wallet });
    await addTx(db, { amountMinor: 250000, currency: "USD", source: "plaid", accountId: checking, merchant: "Payroll", occurredAt: us("2026-09-15") });
    await addTx(db, { amountMinor: -1800, source: "manual", merchant: "Street market", occurredAt: cn("2026-09-20") });
    await addTx(db, { amountMinor: -900, source: "wechat", merchant: "Closed order", occurredAt: cn("2026-09-21"), status: "closed" });

    const r = await analysisReport(db, user, { from: "2026-09-01", to: "2026-09-30" }, opts);
    for (const c of r.currencies) {
      const mine = r.sourceTotals.filter((t) => t.currency === c.currency);
      expect([c.currency, mine.reduce((a, t) => a + t.count, 0)]).toEqual([c.currency, c.transactionCount]);
      expect([c.currency, mine.reduce((a, t) => a + t.spendingMinor, 0)]).toEqual([c.currency, c.spendingMinor]);
      expect([c.currency, mine.reduce((a, t) => a + t.incomeMinor, 0)]).toEqual([c.currency, c.incomeMinor]);
    }
    const plaidKey = r.freshness.find((f) => f.source === "plaid")!.key;
    const byKey = (key: string, currency: string) => r.sourceTotals.find((t) => t.key === key && t.currency === currency);
    expect(byKey("alipay", "USD")).toMatchObject({ source: "alipay", count: 1, spendingMinor: 2000 });
    // Saturdays Sep 5 to 26 (cafe and groceries, 8), Sep 28, three rows on Sep 29, Sep 30: 13; the linked charge left out.
    expect(byKey(plaidKey, "USD")).toMatchObject({ source: "plaid", count: 13, incomeCount: 1, incomeMinor: 250000 });
    expect(byKey("manual", "CNY")).toMatchObject({ source: "manual", count: 1, spendingMinor: 1800 });
    expect(byKey("wechat", "CNY")).toMatchObject({ count: 1, spendingMinor: 1500 });
  });

  it("investments: holdings change split into deposits and market; weekend has no close", async () => {
    const db = await ledger();
    const statement = (asOf: string, cash: string, txns: InvestStatement["transactions"] = []): InvestStatement => ({
      source: "ibkr",
      asOf,
      accounts: [{ externalId: "U3141", name: "IBKR U3141", currency: "USD" }],
      securities: [],
      holdings: [{ accountExternalId: "U3141", securityExternalId: null, currency: "USD", quantity: cash, price: "1", marketValue: cash, costBasis: null, raw: {} }],
      transactions: txns,
      warnings: [],
    });
    await writeStatement(db, user, statement("2026-09-25", "1000.00"));
    await writeStatement(
      db,
      user,
      statement("2026-09-29", "1500.00", [
        { accountExternalId: "U3141", securityExternalId: null, externalId: "dep-1", date: "2026-09-28", type: "transfer", quantity: null, amount: "300.00", currency: "USD", description: "Deposit", raw: {} },
      ]),
    );
    const week = await analysisReport(db, user, { from: "2026-09-28", to: "2026-10-04" }, opts);
    expect(week.investments).toEqual([
      { currency: "USD", startMinor: 100000, endMinor: 150000, changeMinor: 50000, netDepositsMinor: 30000, marketMinor: 20000, dividendCount: 0, partial: false },
    ]);
    const sunday = await analysisReport(db, user, { from: "2026-09-27", to: "2026-09-27" }, opts);
    expect(sunday.close).toEqual({ marketDay: false, previousClose: "2026-09-25" });
    expect(sunday.investments).toEqual([expect.objectContaining({ changeMinor: 0 })]);
  });

  it("a future period is empty and flagged", async () => {
    const db = await ledger();
    const r = await analysisReport(db, user, { from: "2026-10-05", to: "2026-10-05" }, opts);
    expect(r).toMatchObject({ future: true, currencies: [], investments: null });
  });
});
