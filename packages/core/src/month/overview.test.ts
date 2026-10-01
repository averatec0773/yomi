import { describe, expect, it } from "vitest";
import { LedgerError } from "../ledger/errors";
import { addParticipant, addSplit, addTx, catId, freshDb, selfId, user } from "../ledger/test-helpers";
import { getMonthlyTarget, monthOverview, setMonthlyTarget, sharedReceivable } from "./overview";

async function month() {
  const db = await freshDb();
  const food = await catId(db, "餐饮");
  const groc = await catId(db, "买菜");
  const roomie = await addParticipant(db, "室友");
  const at = (d: number) => `2026-09-${String(d).padStart(2, "0")}T12:00:00+08:00`;
  // CNY
  await addTx(db, { amountMinor: -2500, categoryId: food, merchant: "早餐", occurredAt: at(1) }); // small
  await addTx(db, { amountMinor: -3000, categoryId: food, merchant: "午饭", occurredAt: at(2) }); // small (≤ ¥30)
  await addTx(db, { amountMinor: -3001, categoryId: food, merchant: "晚饭", occurredAt: at(3) });
  const shared = await addTx(db, { amountMinor: -20000, categoryId: groc, merchant: "超市", occurredAt: at(4), accountId: null });
  await addSplit(db, shared, await selfId(db), 10000, 20000);
  await addSplit(db, shared, roomie, 10000);
  await addTx(db, { amountMinor: 500, kind: "refund", categoryId: food, merchant: "午饭", occurredAt: at(5) });
  await addTx(db, { amountMinor: -99999, status: "closed", occurredAt: at(6) });
  const orig = await addTx(db, { amountMinor: -4000, merchant: "书店", occurredAt: at(7) });
  await addTx(db, { amountMinor: -4000, source: "icbc_pdf", duplicateOfId: orig, occurredAt: at(7) });
  await addTx(db, { amountMinor: -50000, kind: "transfer", occurredAt: at(8) });
  await addTx(db, { amountMinor: 800000, kind: "income", occurredAt: at(9) });
  // Friend paid: I owe my share, nothing receivable.
  const friendPaid = await addTx(db, { amountMinor: -6000, categoryId: food, merchant: "火锅", occurredAt: at(10) });
  await addSplit(db, friendPaid, await selfId(db), 3000);
  await addSplit(db, friendPaid, roomie, 3000, 6000);
  // USD
  await addTx(db, { amountMinor: -999, currency: "USD", categoryId: food, merchant: "Cafe", occurredAt: at(11) });
  await addTx(db, { amountMinor: -5000, currency: "USD", categoryId: groc, merchant: "Kroger", occurredAt: at(12) });
  // Previous month
  await addTx(db, { amountMinor: -10000, occurredAt: "2026-08-15T12:00:00+08:00" });
  // Next month
  await addTx(db, { amountMinor: -1, occurredAt: "2026-10-01T00:00:00+08:00" });
  return { db, food, groc, orig };
}

describe("monthOverview", () => {
  it("computes per-currency numbers on a hand-built month, never summing currencies", async () => {
    const { db, food, groc, orig } = await month();
    const o = await monthOverview(db, user, "2026-09", { today: "2026-10-05" });
    expect(o.days).toBe(30);
    expect(o.currencies.map((c) => c.currency)).toEqual(["CNY", "USD"]);
    const cny = o.currencies[0]!;
    // 2500 + 3000 + 3001 + 10000 (my half) − 500 + 4000 + 3000 (my half, friend paid)
    expect(cny.spendingMinor).toBe(25001);
    expect(cny.incomeMinor).toBe(800000);
    expect(cny.transactionCount).toBe(7);
    expect(cny.byCategory).toEqual([
      { categoryId: food, name: "餐饮", minor: 11001, count: 5, share: 4400 },
      { categoryId: groc, name: "买菜", minor: 10000, count: 1, share: 4000 },
      { categoryId: null, name: "Uncategorized", minor: 4000, count: 1, share: 1600 },
    ]);
    expect(cny.smallPayments).toEqual({ thresholdMinor: 3000, count: 2, minor: 5500 });
    expect(cny.largest.map((l) => [l.merchant, l.minor])).toEqual([
      ["超市", 10000],
      ["书店", 4000],
      ["晚饭", 3001],
      ["火锅", 3000],
      ["午饭", 3000],
    ]);
    expect(cny.largest.some((l) => l.id === orig)).toBe(true);
    expect(cny.previousMonthSpendingMinor).toBe(10000);
    expect(cny.dailyAverageMinor).toBe(Math.round(25001 / 30));
    expect(cny.sharedReceivableMinor).toBe(10000);
    expect(cny.target).toBeNull();

    const usd = o.currencies[1]!;
    expect(usd).toMatchObject({
      spendingMinor: 5999,
      transactionCount: 2,
      smallPayments: { thresholdMinor: 1000, count: 1, minor: 999 },
      previousMonthSpendingMinor: null,
      sharedReceivableMinor: 0,
    });
    expect(await sharedReceivable(db, user, "2026-09")).toEqual([{ currency: "CNY", minor: 10000 }]);
  });

  it("averages over elapsed days in the current month", async () => {
    const { db } = await month();
    const o = await monthOverview(db, user, "2026-09", { today: "2026-09-10" });
    expect(o.days).toBe(10);
    expect(o.currencies[0]!.dailyAverageMinor).toBe(2500);
  });

  it("uses the month target, else the default, only for its currency", async () => {
    const { db } = await month();
    expect(await getMonthlyTarget(db, user, "2026-09")).toBeNull();
    await setMonthlyTarget(db, user, { month: null, amountMinor: 300000, currency: "CNY" });
    let o = await monthOverview(db, user, "2026-09", { today: "2026-10-01" });
    expect(o.currencies[0]!.target).toEqual({ amountMinor: 300000, currency: "CNY", remainingMinor: 300000 - 25001, monthSpecific: false });
    expect(o.currencies[1]!.target).toBeNull();

    await setMonthlyTarget(db, user, { month: "2026-09", amountMinor: 20000, currency: "USD" });
    await setMonthlyTarget(db, user, { month: "2026-09", amountMinor: 5000, currency: "USD" });
    o = await monthOverview(db, user, "2026-09", { today: "2026-10-01" });
    expect(o.currencies.find((c) => c.currency === "CNY")!.target).toBeNull();
    expect(o.currencies.find((c) => c.currency === "USD")!.target).toEqual({
      amountMinor: 5000,
      currency: "USD",
      remainingMinor: -999,
      monthSpecific: true,
    });
    // Other months still fall back to the default.
    expect(await getMonthlyTarget(db, user, "2026-08")).toMatchObject({ month: null, amountMinor: 300000 });
    // An empty month shows the target currency with zero spending.
    const empty = await monthOverview(db, user, "2025-01", { today: "2026-10-01" });
    expect(empty.currencies).toMatchObject([{ currency: "CNY", spendingMinor: 0, target: { remainingMinor: 300000 } }]);
    await expect(setMonthlyTarget(db, user, { month: "2026-9", amountMinor: 1, currency: "CNY" })).rejects.toThrow(LedgerError);
    await expect(setMonthlyTarget(db, user, { month: null, amountMinor: 1.5, currency: "CNY" })).rejects.toThrow(LedgerError);
  });
});
