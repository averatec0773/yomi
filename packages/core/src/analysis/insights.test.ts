import { describe, expect, it } from "vitest";
import { type AnalysisRow, categoryShifts, newMerchants, shiftFloor, splitInvestmentChange, topMerchants, typicalSpending, unusualItems } from "./insights";
import { typicalRanges } from "./period";

let nextId = 1;
/** A counted expense of `minor` (my share) on `day`; fictional merchants only. */
function row(day: string, minor: number, p: Partial<AnalysisRow> = {}): AnalysisRow {
  return {
    id: nextId++,
    occurredOn: day,
    occurredAt: `${day}T12:00:00-05:00`,
    amountMinor: -minor,
    currency: "USD",
    kind: "expense",
    status: "ok",
    duplicateOfId: null,
    provisional: null,
    merchant: "Corner Cafe",
    categoryId: 1,
    source: "plaid",
    myShareMinor: minor,
    ...p,
  };
}

describe("typicalSpending", () => {
  const weeks = typicalRanges({ from: "2026-09-28", to: "2026-10-04" }, "week");

  it("averages the previous complete periods, empty ones as 0", () => {
    const rows = [row("2026-09-01", 7000), row("2026-09-08", 2100), row("2026-09-23", 1400), row("2026-09-23", 500, { currency: "CNY" })];
    // Four weeks from Aug 31: 7000, 2100, 0, 1400.
    expect(typicalSpending(rows, weeks, "USD", "2026-08-01")).toEqual({ periods: 4, perPeriodMinor: 2625, dailyMinor: 375 });
  });

  it("drops periods before the currency's history and needs two", () => {
    const rows = [row("2026-09-15", 7000), row("2026-09-23", 1400)];
    expect(typicalSpending(rows, weeks, "USD", "2026-09-14")).toEqual({ periods: 2, perPeriodMinor: 4200, dailyMinor: 600 });
    expect(typicalSpending(rows, weeks, "USD", "2026-09-21")).toBeNull();
    expect(typicalSpending(rows, weeks, "USD", null)).toBeNull();
  });

  it("follows the spending rule: transfers, closed rows and linked duplicates do not count, refunds subtract", () => {
    const rows = [
      row("2026-09-01", 1000),
      row("2026-09-02", 500, { kind: "transfer" }),
      row("2026-09-03", 500, { status: "closed" }),
      row("2026-09-04", 500, { duplicateOfId: 1 }),
      row("2026-09-05", -200, { kind: "refund", amountMinor: 200 }),
      row("2026-09-08", 0),
    ];
    expect(typicalSpending(rows, weeks, "USD", "2026-08-01")!.perPeriodMinor).toBe(200);
  });
});

describe("topMerchants", () => {
  it("ranks by total, then count, then name, with shares", () => {
    const rows = [
      row("2026-09-01", 3000, { merchant: "Bean Barn" }),
      row("2026-09-02", 1000, { merchant: "Corner Cafe" }),
      row("2026-09-03", 2000, { merchant: "corner cafe " }),
      row("2026-09-04", 3000, { merchant: "Aster Books" }),
      row("2026-09-05", 1000, { merchant: "" }),
      row("2026-09-06", 900, { merchant: "Bean Barn", currency: "CNY" }),
    ];
    expect(topMerchants(rows, "USD", 2)).toEqual([
      { merchant: "Corner Cafe", minor: 3000, count: 2, share: 3000 },
      { merchant: "Aster Books", minor: 3000, count: 1, share: 3000 },
    ]);
    expect(topMerchants(rows, "USD").map((m) => m.merchant)).toEqual(["Corner Cafe", "Aster Books", "Bean Barn"]);
  });

  it("leaves out merchants whose refunds cancel them", () => {
    const rows = [row("2026-09-01", 1000, { merchant: "Aster Books" }), row("2026-09-02", -1000, { merchant: "Aster Books", kind: "refund", amountMinor: 1000 })];
    expect(topMerchants(rows, "USD")).toEqual([]);
  });
});

describe("categoryShifts", () => {
  it("keeps changes of at least 20% and the floor, largest first, at most three", () => {
    const current = [
      { categoryId: 1, name: "Dining", minor: 30000 },
      { categoryId: 2, name: "Groceries", minor: 11000 },
      { categoryId: 3, name: "Transport", minor: 5000 },
      { categoryId: null, name: "Uncategorized", minor: 4000 },
      { categoryId: 5, name: "Books", minor: 2500 },
    ];
    const typical = [
      { categoryId: 1, name: "Dining", minor: 20000 },
      // +1000 on 10000: 10%, not a shift.
      { categoryId: 2, name: "Groceries", minor: 10000 },
      { categoryId: 3, name: "Transport", minor: 9000 },
      { categoryId: 4, name: "Travel", minor: 6000 },
      // +1500: below the $20 floor.
      { categoryId: 5, name: "Books", minor: 1000 },
    ];
    expect(categoryShifts(current, typical, "USD")).toEqual([
      { categoryId: 1, name: "Dining", currentMinor: 30000, typicalMinor: 20000, deltaMinor: 10000 },
      { categoryId: 4, name: "Travel", currentMinor: 0, typicalMinor: 6000, deltaMinor: -6000 },
      { categoryId: 3, name: "Transport", currentMinor: 5000, typicalMinor: 9000, deltaMinor: -4000 },
    ]);
    expect(categoryShifts(current, typical, "USD", 5).map((s) => s.name)).toContain("Uncategorized");
  });

  it("uses the currency's floor", () => {
    expect(shiftFloor("CNY")).toBe(10000);
    expect(shiftFloor("HKD")).toBe(2000);
    const shifts = categoryShifts([{ categoryId: 1, name: "Dining", minor: 18000 }], [{ categoryId: 1, name: "Dining", minor: 9000 }], "CNY");
    expect(shifts).toEqual([]);
  });
});

describe("unusualItems", () => {
  const history = [row("2026-06-01", 600), row("2026-07-01", 640), row("2026-08-01", 700), row("2026-09-01", 650)];

  it("flags a charge at least twice the merchant's median and over the floor", () => {
    const big = row("2026-09-20", 2500);
    const small = row("2026-09-21", 1300);
    const out = unusualItems([big, small], [...history, big, small], "USD", { since: "2026-01-01" });
    expect(out).toEqual([{ kind: "larger_than_usual", id: big.id, merchant: "Corner Cafe", minor: 2500, occurredOn: "2026-09-20", source: "plaid", usualMinor: 645 }]);
  });

  it("needs three earlier charges within 180 days", () => {
    const big = row("2026-09-20", 2500);
    const old = [row("2026-01-01", 600), row("2026-02-01", 600), row("2026-09-10", 600)];
    expect(unusualItems([big], [...old, big], "USD", { since: "2025-01-01" })).toEqual([]);
  });

  it("flags a first large charge only with 60 days of history", () => {
    const tv = row("2026-09-20", 12000, { merchant: "Bright Screens" });
    const out = unusualItems([tv], [...history, tv], "USD", { since: "2026-06-01" });
    expect(out.map((u) => u.kind)).toEqual(["first_large"]);
    expect(unusualItems([tv], [tv], "USD", { since: "2026-08-01" })).toEqual([]);
    expect(unusualItems([row("2026-09-20", 9000, { merchant: "Bright Screens" })], history, "USD", { since: "2026-01-01" })).toEqual([]);
  });

  it("flags same merchant, amount and day from two sources, not repeats within one source", () => {
    const a = row("2026-09-20", 4200, { merchant: "Lumen Gym", source: "plaid" });
    const b = row("2026-09-20", 4200, { merchant: "Lumen Gym", source: "boa_csv" });
    const c = row("2026-09-21", 1500, { merchant: "Bean Barn", source: "plaid" });
    const d = row("2026-09-21", 1500, { merchant: "Bean Barn", source: "plaid" });
    const linked = row("2026-09-21", 1500, { merchant: "Bean Barn", source: "boa_csv", duplicateOfId: c.id });
    const out = unusualItems([a, b, c, d, linked], [a, b, c, d, linked], "USD", { since: "2026-01-01" });
    expect(out).toEqual([{ kind: "possible_duplicate", id: b.id, otherId: a.id, otherSource: "plaid", merchant: "Lumen Gym", minor: 4200, occurredOn: "2026-09-20", source: "boa_csv" }]);
  });

  it("skips provisional captures: their statement row would flag the same charge again", () => {
    const sms = row("2026-09-20", 4200, { merchant: "Lumen Gym", source: "sms", provisional: "capture" });
    const card = row("2026-09-20", 4200, { merchant: "Lumen Gym", source: "icbc_pdf" });
    const big = row("2026-09-21", 90000, { merchant: "Harbor Grill", source: "sms", provisional: "capture" });
    expect(unusualItems([sms, card, big], [...history, sms, card, big], "USD", { since: "2026-01-01" })).toEqual([]);
    expect(newMerchants([big], [big], "USD", { since: "2026-01-01" })).toEqual([]);
  });

  it("caps the list at five, largest first", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row("2026-09-20", 10000 + i * 100, { merchant: `Shop ${i}` }));
    const out = unusualItems(rows, [...history, ...rows], "USD", { since: "2026-01-01" });
    expect(out.map((u) => u.minor)).toEqual([10600, 10500, 10400, 10300, 10200]);
  });
});

describe("newMerchants", () => {
  const history = [row("2026-06-01", 600), row("2026-03-01", 900, { merchant: "Lumen Gym" })];

  it("lists merchants with no charge in the 180 days before, largest first", () => {
    const period = [
      row("2026-09-20", 3000, { merchant: "Harbor Grill" }),
      row("2026-09-22", 1500, { merchant: "harbor grill" }),
      row("2026-09-21", 650),
      row("2026-09-21", 2000, { merchant: "Lumen Gym" }),
      row("2026-09-23", 800, { merchant: "Aster Books" }),
      row("2026-09-24", 500, { merchant: "Aster Books", kind: "transfer" }),
    ];
    expect(newMerchants(period, [...history, ...period], "USD", { since: "2026-03-01" })).toEqual([
      { merchant: "Harbor Grill", minor: 4500, count: 2, firstOn: "2026-09-20" },
      // Lumen Gym's earlier charge is more than 180 days back.
      { merchant: "Lumen Gym", minor: 2000, count: 1, firstOn: "2026-09-21" },
      { merchant: "Aster Books", minor: 800, count: 1, firstOn: "2026-09-23" },
    ]);
  });

  it("leaves out manual entries", () => {
    const period = [row("2026-09-20", 3000, { merchant: "Birthday gift", source: "manual" })];
    expect(newMerchants(period, period, "USD", { since: "2026-01-01" })).toEqual([]);
    expect(unusualItems(period, period, "USD", { since: "2026-01-01" })).toEqual([]);
  });

  it("needs 60 days of history before the first charge", () => {
    const period = [row("2026-09-20", 3000, { merchant: "Harbor Grill" })];
    expect(newMerchants(period, period, "USD", { since: "2026-08-01" })).toEqual([]);
    expect(newMerchants(period, period, "USD", { since: null })).toEqual([]);
  });
});

describe("splitInvestmentChange", () => {
  const flows = [
    { type: "transfer" as const, amountMinor: 50000, currency: "USD" },
    { type: "transfer" as const, amountMinor: -10000, currency: "USD" },
    { type: "dividend" as const, amountMinor: 1200, currency: "USD" },
    { type: "buy" as const, amountMinor: -30000, currency: "USD" },
    { type: "transfer" as const, amountMinor: 9999, currency: "HKD" },
  ];

  it("splits the change into net deposits and market", () => {
    expect(splitInvestmentChange(1_000_000, 1_065_000, flows, "USD")).toEqual({
      currency: "USD",
      startMinor: 1_000_000,
      endMinor: 1_065_000,
      changeMinor: 65000,
      netDepositsMinor: 40000,
      marketMinor: 25000,
      dividendCount: 1,
      partial: false,
    });
  });

  it("has no change without a start, and no market change while partial", () => {
    expect(splitInvestmentChange(null, 500, flows, "USD")).toMatchObject({ changeMinor: null, marketMinor: null, netDepositsMinor: 40000 });
    expect(splitInvestmentChange(100, 500, flows, "USD", true)).toMatchObject({ changeMinor: 400, marketMinor: null, partial: true });
  });
});
