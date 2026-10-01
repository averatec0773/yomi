import { describe, expect, it } from "vitest";
import { LedgerError } from "../ledger/errors";
import { addParticipant, addSplit, addTx, catId, freshDb, selfId, user } from "../ledger/test-helpers";
import { listTransactions, rangeTotalsForList } from "../ledger/transactions";
import { monthOverview, setMonthlyTarget } from "../month/overview";
import { rangeOverview } from "./range";

const at = (date: string) => `${date}T12:00:00+08:00`;

async function ledger() {
  const db = await freshDb();
  const food = await catId(db, "餐饮");
  const roomie = await addParticipant(db, "室友");
  // 2024: leap day and the months around it.
  await addTx(db, { amountMinor: -1000, categoryId: food, occurredAt: at("2024-01-31") });
  await addTx(db, { amountMinor: -2900, categoryId: food, occurredAt: at("2024-02-29") });
  await addTx(db, { amountMinor: -100, occurredAt: at("2024-03-01") });
  // 2026 Q3, CNY and USD.
  await addTx(db, { amountMinor: -5000, categoryId: food, merchant: "面馆", occurredAt: at("2026-07-01") });
  await addTx(db, { amountMinor: -3000, merchant: "书店", occurredAt: at("2026-08-15") });
  const shared = await addTx(db, { amountMinor: -20000, merchant: "超市", occurredAt: at("2026-09-04") });
  await addSplit(db, shared, await selfId(db), 10000, 20000);
  await addSplit(db, shared, roomie, 10000);
  await addTx(db, { amountMinor: 500, kind: "refund", categoryId: food, occurredAt: at("2026-09-05") });
  await addTx(db, { amountMinor: -99999, status: "closed", occurredAt: at("2026-09-06") });
  const orig = await addTx(db, { amountMinor: -4000, occurredAt: at("2026-09-07") });
  await addTx(db, { amountMinor: -4000, source: "icbc_pdf", duplicateOfId: orig, occurredAt: at("2026-09-07") });
  await addTx(db, { amountMinor: -50000, kind: "transfer", occurredAt: at("2026-09-08") });
  await addTx(db, { amountMinor: 800000, kind: "income", occurredAt: at("2026-09-09") });
  await addTx(db, { amountMinor: -1200, currency: "USD", occurredAt: at("2026-08-20") });
  await addTx(db, { amountMinor: -800, currency: "USD", occurredAt: at("2026-09-30") });
  // Previous quarter (April to June).
  await addTx(db, { amountMinor: -7000, occurredAt: at("2026-04-01") });
  await addTx(db, { amountMinor: -1000, occurredAt: at("2026-06-30") });
  // Just outside Q3 on both ends.
  await addTx(db, { amountMinor: -1, occurredAt: "2026-10-01T00:00:00+08:00" });
  return { db, food };
}

describe("rangeOverview", () => {
  it("sums a multi-month range per currency with a monthly series that adds up", async () => {
    const { db } = await ledger();
    const o = await rangeOverview(db, user, { from: "2026-07-01", to: "2026-09-30" }, { today: "2026-10-05" });
    expect(o).toMatchObject({ days: 92, lengthDays: 92, inProgress: false, month: null });
    expect(o.previous).toEqual({ from: "2026-04-01", to: "2026-06-30", days: 91 });
    const [cny, usd] = o.currencies;
    // 5000 + 3000 + 10000 (my half) − 500 + 4000
    expect(cny).toMatchObject({ currency: "CNY", spendingMinor: 21500, incomeMinor: 800000, transactionCount: 5, sharedReceivableMinor: 10000 });
    expect(cny!.dailyAverageMinor).toBe(Math.round(21500 / 92));
    expect(cny!.previous).toEqual({ spendingMinor: 8000, incomeMinor: 0, transactionCount: 2, dailyAverageMinor: Math.round(8000 / 91) });
    expect(cny!.monthly).toEqual([
      { month: "2026-07", spendingMinor: 5000, partial: false },
      { month: "2026-08", spendingMinor: 3000, partial: false },
      { month: "2026-09", spendingMinor: 13500, partial: false },
    ]);
    expect(cny!.monthly!.reduce((a, m) => a + m.spendingMinor, 0)).toBe(cny!.spendingMinor);
    expect(cny!.target).toBeNull();
    expect(usd).toMatchObject({ currency: "USD", spendingMinor: 2000, previous: null });
    expect(usd!.monthly!.map((m) => m.spendingMinor)).toEqual([0, 1200, 800]);
  });

  it("uses elapsed days and flags partial months while the range contains today", async () => {
    const { db } = await ledger();
    const o = await rangeOverview(db, user, { from: "2026-08-15", to: "2026-12-31" }, { today: "2026-09-10" });
    expect(o.inProgress).toBe(true);
    expect(o.days).toBe(27);
    // Future months without rows are left out of the series.
    expect(o.currencies[0]!.monthly).toEqual([
      { month: "2026-08", spendingMinor: 3000, partial: true },
      { month: "2026-09", spendingMinor: 13500, partial: true },
      { month: "2026-10", spendingMinor: 1, partial: true },
    ]);
    // Equal-length previous period.
    expect(o.previous).toEqual({ from: "2026-03-29", to: "2026-08-14", days: 139 });
  });

  it("handles leap-year months", async () => {
    const { db } = await ledger();
    const feb = await rangeOverview(db, user, { from: "2024-02-01", to: "2024-02-29" }, { today: "2026-01-01" });
    expect(feb).toMatchObject({ days: 29, month: "2024-02", previous: { from: "2024-01-01", to: "2024-01-31", days: 31 } });
    expect(feb.currencies[0]).toMatchObject({ spendingMinor: 2900, dailyAverageMinor: 100, monthly: null, previous: { spendingMinor: 1000 } });
    const march = await rangeOverview(db, user, { from: "2024-03-01", to: "2024-03-10" }, { today: "2026-01-01" });
    expect(march.previous).toEqual({ from: "2024-02-20", to: "2024-02-29", days: 10 });
    expect(march.currencies[0]!.previous!.spendingMinor).toBe(2900);
  });

  it("shows the target only for exactly one calendar month", async () => {
    const { db } = await ledger();
    await setMonthlyTarget(db, user, { month: null, amountMinor: 300000, currency: "CNY" });
    const month = await rangeOverview(db, user, { from: "2026-09-01", to: "2026-09-30" }, { today: "2026-10-01" });
    expect(month.currencies.find((c) => c.currency === "CNY")!.target).toMatchObject({ amountMinor: 300000 });
    const quarter = await rangeOverview(db, user, { from: "2026-07-01", to: "2026-09-30" }, { today: "2026-10-01" });
    expect(quarter.currencies.every((c) => c.target == null)).toBe(true);
    const partMonth = await rangeOverview(db, user, { from: "2026-09-01", to: "2026-09-29" }, { today: "2026-10-01" });
    expect(partMonth.month).toBeNull();
    expect(partMonth.currencies.every((c) => c.target == null)).toBe(true);
  });

  it("rejects invalid and too long ranges", async () => {
    const { db } = await ledger();
    await expect(rangeOverview(db, user, { from: "2026-09-30", to: "2026-09-01" })).rejects.toThrow(LedgerError);
    await expect(rangeOverview(db, user, { from: "2020-01-01", to: "2026-01-01" })).rejects.toThrow(LedgerError);
    await expect(rangeOverview(db, user, { from: "2026-02-29", to: "2026-03-01" })).rejects.toThrow(LedgerError);
  });

  it("monthOverview is rangeOverview over the calendar month", async () => {
    const { db } = await ledger();
    await setMonthlyTarget(db, user, { month: "2026-08", amountMinor: 5000, currency: "USD" });
    for (const [month, today] of [
      ["2026-09", "2026-10-05"],
      ["2026-09", "2026-09-10"],
      ["2026-08", "2026-10-05"],
      ["2024-02", "2026-10-05"],
      ["2030-01", "2026-10-05"],
    ] as const) {
      const m = await monthOverview(db, user, month, { today });
      const r = await rangeOverview(db, user, { from: `${month}-01`, to: `${month}-${month === "2024-02" ? "29" : month === "2026-09" ? "30" : "31"}` }, { today });
      expect(m.days).toBe(r.days);
      expect(m.currencies).toEqual(
        r.currencies.map(({ previous, monthly: _m, ...c }) => ({
          currency: c.currency,
          spendingMinor: c.spendingMinor,
          incomeMinor: c.incomeMinor,
          transactionCount: c.transactionCount,
          byCategory: c.byCategory,
          smallPayments: c.smallPayments,
          largest: c.largest,
          previousMonthSpendingMinor: previous?.spendingMinor ?? null,
          dailyAverageMinor: c.dailyAverageMinor,
          sharedReceivableMinor: c.sharedReceivableMinor,
          target: c.target,
        })),
      );
    }
  });
});

describe("listTransactions from/to", () => {
  it("filters by inclusive dates, alone or with other filters", async () => {
    const { db, food } = await ledger();
    const q3 = await listTransactions(db, user, { from: "2026-07-01", to: "2026-09-30" });
    expect(q3.total).toBe(11);
    expect(q3.items.at(-1)!.occurredAt).toBe(at("2026-07-01"));
    expect(q3.items[0]!.occurredAt).toBe(at("2026-09-30"));
    expect((await listTransactions(db, user, { from: "2026-07-01", to: "2026-09-30", categoryId: food })).total).toBe(2);
    expect((await listTransactions(db, user, { from: "2024-02-29", to: "2024-02-29" })).total).toBe(1);
    expect((await listTransactions(db, user, { from: "2026-10-01" })).total).toBe(1);
    // month still works and combines with a range.
    expect((await listTransactions(db, user, { month: "2026-09", from: "2026-09-05", to: "2026-09-07" })).total).toBe(4);
    await expect(listTransactions(db, user, { from: "2026-02-30" })).rejects.toThrow(LedgerError);
    expect(await rangeTotalsForList(db, user, "2026-07-01", "2026-09-30")).toEqual([
      { currency: "CNY", count: 5, spendingMinor: 21500 },
      { currency: "USD", count: 2, spendingMinor: 2000 },
    ]);
  });
});
