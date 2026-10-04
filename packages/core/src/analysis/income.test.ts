import { describe, expect, it } from "vitest";
import { setCountsAsIncome } from "../ledger/update";
import { addSplit, addTx, catId, freshDb, selfId, user } from "../ledger/test-helpers";
import { createParticipant, markAsSettlement } from "../split";
import { rangeOverview } from "../stats/range";
import { incomeSummary } from "./income";

// Fictional: Jordan Park pays back; card 3141.
const at = (d: string) => `2026-09-${d}T12:00:00+08:00`;

async function ledger() {
  const db = await freshDb();
  const [salary, family, reimb, dining] = [await catId(db, "工资"), await catId(db, "家人资助"), await catId(db, "报销"), await catId(db, "餐饮")];
  await addTx(db, { amountMinor: 300000, currency: "USD", categoryId: salary, occurredAt: at("01") });
  await addTx(db, { amountMinor: 100000, currency: "USD", categoryId: family, occurredAt: at("02") });
  await addTx(db, { amountMinor: 20000, currency: "USD", categoryId: reimb, occurredAt: at("03") });
  await addTx(db, { amountMinor: 5000, currency: "USD", occurredAt: at("04") });
  await addTx(db, { amountMinor: 9999, currency: "USD", status: "closed", categoryId: salary, occurredAt: at("05") });
  await addTx(db, { amountMinor: -150000, currency: "USD", categoryId: dining, occurredAt: at("06") });
  const dinner = await addTx(db, { amountMinor: -10000, currency: "USD", categoryId: dining, occurredAt: at("07") });
  const jordan = (await createParticipant(db, user, "Jordan Park")).id;
  await addSplit(db, dinner, await selfId(db), 5000, 10000, "USD");
  await addSplit(db, dinner, jordan, 5000, 0, "USD");
  const back = await addTx(db, { amountMinor: 5000, currency: "USD", source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: "Jordan Park", occurredAt: at("08") });
  await markAsSettlement(db, user, back, { participantId: jordan });
  await addTx(db, { amountMinor: 70000, currency: "USD", kind: "transfer", occurredAt: at("09") });
  await addTx(db, { amountMinor: 880000, categoryId: salary, occurredAt: at("10") });
  return { db, family };
}

describe("income numbers", () => {
  it("counts income by the category flag, nets my share of spending, and keeps transfers and repayments apart", async () => {
    const { db } = await ledger();
    const s = await incomeSummary(db, user, { from: "2026-09-01", to: "2026-09-30" }, { today: "2026-10-01" });
    expect(s).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(s.currencies.map((c) => c.currency)).toEqual(["CNY", "USD"]);
    expect(s.currencies[1]).toEqual({
      currency: "USD",
      incomeMinor: 405000,
      incomeNotCountedMinor: 20000,
      spendingMinor: 155000,
      netMinor: 250000,
      savingsRateBp: 6173,
      byCategory: [
        { key: "salary", name: "工资", minor: 300000, count: 1, counted: true },
        { key: "familySupport", name: "家人资助", minor: 100000, count: 1, counted: true },
        { key: null, name: "Uncategorized", minor: 5000, count: 1, counted: true },
        { key: "reimbursement", name: "报销", minor: 20000, count: 1, counted: false },
      ],
      transfersInMinor: 70000,
      repaymentsMinor: 5000,
    });
    expect((await incomeSummary(db, user, { from: "2026-09-01", to: "2026-09-30", currency: "cny" }, { today: "2026-10-01" })).currencies).toEqual([
      expect.objectContaining({ currency: "CNY", incomeMinor: 880000, spendingMinor: 0, savingsRateBp: 10000 }),
    ]);
  });

  it("the same numbers reach the period overview; turning a category off moves it out of income", async () => {
    const { db, family } = await ledger();
    const usd = async () => (await rangeOverview(db, user, { from: "2026-09-01", to: "2026-09-30" }, { today: "2026-10-01" })).currencies.find((c) => c.currency === "USD")!;
    expect(await usd()).toMatchObject({ incomeMinor: 405000, incomeNotCountedMinor: 20000, netMinor: 250000, savingsRateBp: 6173 });
    expect((await usd()).incomeByCategory.map((c) => [c.name, c.counted, c.share])).toEqual([
      ["工资", true, 7059],
      ["家人资助", true, 2353],
      ["Uncategorized", true, 118],
      ["报销", false, 471],
    ]);
    await setCountsAsIncome(db, user, family, false);
    expect(await usd()).toMatchObject({ incomeMinor: 305000, incomeNotCountedMinor: 120000, netMinor: 150000, savingsRateBp: 4918 });
  });
});
