import { accounts, categories, type Db, settlementItems, transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { seed } from "../seed";
import { setDisplayName } from "../settings/profile";
import { getCurrentUser } from "../user";
import type { AaEvent } from "./balances";
import {
  allocateItems,
  balances,
  coverageOf,
  createFriendPaidExpense,
  createParticipant,
  deleteSettlement,
  getSharedNote,
  listSettlements,
  markAsSettlement,
  openItems,
  recordOpeningBalance,
  recordSettlement,
  setSharedNote,
  setSplit,
  settleAll,
  statementText,
  toggleParticipant,
} from "./index";

const user = getCurrentUser();

async function freshDb(): Promise<Db> {
  const db = await testDb();
  await seed(db);
  await db.insert(accounts).values({ userId: user.id, name: "Wallet", kind: "wallet", institution: "x", currency: "USD" });
  return db;
}

let seq = 0;
async function addTx(db: Db, amountMinor: number, date: string, merchant: string, currency = "USD"): Promise<number> {
  seq += 1;
  return (await db
    .insert(transactions)
    .values({
      userId: user.id,
      accountId: 1,
      occurredAt: `${date}T12:00:00+08:00`,
      amountMinor,
      currency,
      kind: amountMinor < 0 ? "expense" : "income",
      merchant,
      source: "manual",
      dedupKey: `items:${seq}`,
    })
    .returning({ id: transactions.id }))[0]!.id;
}

/** Expense of `total` split equally with `pid`: their share is total / 2. */
async function shared(db: Db, pid: number, total: number, date: string, merchant: string, currency = "USD"): Promise<number> {
  const id = await addTx(db, -total, date, merchant, currency);
  await toggleParticipant(db, user, id, pid);
  return id;
}

const owed = async (db: Db, pid: number, c = "USD") => (await balances(db, user)).find((b) => b.participantId === pid && b.currency === c)?.owedToMeMinor ?? 0;

describe("coverageOf (pure)", () => {
  const split = (id: number, delta: number, date: string): AaEvent => ({
    type: "split",
    participantId: 1,
    currency: "USD",
    date,
    sortKey: `${date}|1|${id}`,
    deltaMinor: delta,
    transactionId: id,
    occurredAt: date,
    merchant: `m${id}`,
    totalMinor: -2 * Math.abs(delta),
    owedMinor: Math.max(delta, 0),
    paidMinor: 0,
    sharedNote: null,
  });
  const pay = (id: number, amount: number, date: string, opening = false): AaEvent => ({
    type: "settlement",
    participantId: 1,
    currency: "USD",
    date,
    sortKey: `${date}|${opening ? 0 : 2}|${id}`,
    deltaMinor: -amount,
    settlementId: id,
    amountMinor: amount,
    originalAmountMinor: null,
    originalCurrency: null,
    fxRate: null,
    note: null,
    opening,
  });
  const state = (c: ReturnType<typeof coverageOf>) => c.entries.map((e) => [e.transactionId ?? "opening", e.status, e.remainingMinor]);

  it("legacy FIFO covers the oldest items, the last one partly", () => {
    const c = coverageOf([split(1, 5000, "2026-09-01"), split(2, 3000, "2026-09-02"), split(3, 2000, "2026-09-03"), pay(9, 6000, "2026-09-10")], []);
    expect(state(c)).toEqual([
      [1, "covered", 0],
      [2, "partial", 2000],
      [3, "open", 2000],
    ]);
    expect(c.balanceMinor).toBe(4000);
    expect(c.unmatchedMinor).toBe(0);
  });

  it("nets items against each other like the running balance", () => {
    // I paid groceries (+50), they paid dinner (-30), they send 20: everything is settled.
    const c = coverageOf([split(1, 5000, "2026-09-01"), split(2, -3000, "2026-09-02"), pay(9, 2000, "2026-09-03")], []);
    expect(state(c)).toEqual([
      [1, "covered", 0],
      [2, "covered", 0],
    ]);
    // With no payment, items that cancel out are covered too; the rest stays open.
    const d = coverageOf([split(1, 5000, "2026-09-01"), split(2, -5000, "2026-09-02"), split(3, 2000, "2026-09-03")], []);
    expect(state(d)).toEqual([
      [1, "covered", 0],
      [2, "covered", 0],
      [3, "open", 2000],
    ]);
  });

  it("explicit items first, then the pool; paying ahead is unmatched", () => {
    const events = [split(1, 5000, "2026-09-01"), split(2, 3000, "2026-09-02"), pay(8, 3000, "2026-09-05"), pay(9, 6000, "2026-09-06")];
    // Settlement 8 named item 2; settlement 9 is legacy and covers item 1 plus 1000 paid ahead.
    const c = coverageOf(events, [{ settlementId: 8, transactionId: 2, amountMinor: 3000 }]);
    expect(state(c)).toEqual([
      [1, "covered", 0],
      [2, "covered", 0],
    ]);
    expect(c.unmatchedMinor).toBe(-1000);
    expect(c.balanceMinor).toBe(5000 + 3000 - 3000 - 6000);
    expect(c.itemsBySettlement.get(8)).toEqual([{ settlementId: 8, transactionId: 2, amountMinor: 3000 }]);
  });

  it("an item row whose split is gone returns its amount to the pool", () => {
    const c = coverageOf([split(1, 5000, "2026-09-01"), pay(8, 3000, "2026-09-05")], [{ settlementId: 8, transactionId: 77, amountMinor: 3000 }]);
    expect(state(c)).toEqual([[1, "partial", 2000]]);
    expect(c.itemsBySettlement.has(8)).toBe(false);
  });

  it("opening balances are entries too", () => {
    const c = coverageOf([pay(5, -10000, "2026-08-01", true), split(1, 5000, "2026-09-01"), pay(9, 12000, "2026-09-05")], []);
    expect(state(c)).toEqual([
      ["opening", "covered", 0],
      [1, "partial", 3000],
    ]);
  });

  it("the identity holds: balance = Σ remaining + unmatched = Σ deltas", () => {
    let s = 7;
    const rnd = (n: number) => ((s = (s * 48271) % 2147483647), s % n);
    for (let round = 0; round < 200; round++) {
      const events: AaEvent[] = [];
      const rows: { settlementId: number; transactionId: number; amountMinor: number }[] = [];
      for (let i = 1; i <= 8; i++) {
        const d = `2026-09-${String(i * 2).padStart(2, "0")}`;
        events.push(split(i, (rnd(2) ? 1 : -1) * (1 + rnd(9000)), d));
        if (rnd(3) === 0) {
          const amount = (rnd(4) ? 1 : -1) * (1 + rnd(9000));
          events.push(pay(100 + i, amount, d));
          if (rnd(2)) rows.push({ settlementId: 100 + i, transactionId: 1 + rnd(i), amountMinor: Math.round(amount / 2) || 1 });
        }
      }
      const c = coverageOf(events, rows);
      const total = events.reduce((acc, e) => acc + e.deltaMinor, 0);
      expect(c.balanceMinor).toBe(total);
      expect(c.entries.reduce((acc, e) => acc + e.remainingMinor, 0) + c.unmatchedMinor).toBe(total);
      for (const e of c.entries) expect(e.remainingMinor === 0 || Math.sign(e.remainingMinor) === Math.sign(e.deltaMinor)).toBe(true);
    }
  });
});

describe("allocateItems", () => {
  it("takes a smaller amount off the newest items first", () => {
    const items = [
      { transactionId: 1, remainingMinor: 5000 },
      { transactionId: 2, remainingMinor: -3000 },
      { transactionId: 3, remainingMinor: 4000 },
    ];
    expect(allocateItems(items, 6000)).toEqual([
      { transactionId: 1, amountMinor: 5000 },
      { transactionId: 2, amountMinor: -3000 },
      { transactionId: 3, amountMinor: 4000 },
    ]);
    expect(allocateItems(items, 2000)).toEqual([
      { transactionId: 1, amountMinor: 5000 },
      { transactionId: 2, amountMinor: -3000 },
    ]);
    expect(allocateItems(items, 1000)).toEqual([
      { transactionId: 1, amountMinor: 4000 },
      { transactionId: 2, amountMinor: -3000 },
    ]);
    expect(allocateItems(items, 6001)).toBeNull();
    expect(allocateItems(items, -100)).toBeNull();
  });
});

describe("item settlements", () => {
  it("settles chosen items; they leave the open list and the balance moves by the amount", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    const t1 = await shared(db, a.id, 4000, "2026-08-02", "Costco");
    const t2 = await shared(db, a.id, 6000, "2026-08-20", "Dinner");
    const t3 = await shared(db, a.id, 2000, "2026-09-03", "Cafe");
    expect((await openItems(db, user, a.id, "USD")).map((i) => i.transactionId)).toEqual([t1, t2, t3]);

    const s = await recordSettlement(db, user, { participantId: a.id, amountMinor: 3000, currency: "USD", settledOn: "2026-09-10", itemTransactionIds: [t3, t1] });
    expect((await db.select().from(settlementItems).where(eq(settlementItems.settlementId, s.id))).map((r) => [r.transactionId, r.amountMinor])).toEqual([
      [t1, 2000],
      [t3, 1000],
    ]);
    expect((await openItems(db, user, a.id, "USD")).map((i) => [i.transactionId, i.status])).toEqual([[t2, "open"]]);
    expect(await owed(db, a.id)).toBe(3000);

    // Choosing a paid item again is refused; so is paying more than the items.
    await expect(recordSettlement(db, user, { participantId: a.id, amountMinor: 1000, currency: "USD", settledOn: "2026-09-11", itemTransactionIds: [t1] })).rejects.toThrow(expect.objectContaining({ code: "settlement_item_not_open" }));
    await expect(recordSettlement(db, user, { participantId: a.id, amountMinor: 3001, currency: "USD", settledOn: "2026-09-11", itemTransactionIds: [t2] })).rejects.toThrow(expect.objectContaining({ code: "settlement_items_amount_invalid" }));

    // Less than the items: the newest keeps the rest open.
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 2000, currency: "USD", settledOn: "2026-09-12", itemTransactionIds: [t2] });
    expect(await openItems(db, user, a.id, "USD")).toEqual([expect.objectContaining({ transactionId: t2, status: "partial", remainingMinor: 1000 })]);

    // Deleting a settlement reopens its items.
    await deleteSettlement(db, user, s.id);
    expect((await openItems(db, user, a.id, "USD")).map((i) => i.transactionId)).toEqual([t1, t2, t3]);
    expect(await owed(db, a.id)).toBe(4000);
  });

  it("legacy amount-only settlements keep working next to item settlements", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    const t1 = await shared(db, a.id, 4000, "2026-08-02", "Costco");
    const t2 = await shared(db, a.id, 6000, "2026-08-20", "Dinner");
    const t3 = await shared(db, a.id, 2000, "2026-09-03", "Cafe");
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 1000, currency: "USD", settledOn: "2026-09-10", itemTransactionIds: [t3] });
    // A plain $25 payment covers the oldest open items: Costco $20, then $5 of Dinner.
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 2500, currency: "USD", settledOn: "2026-09-11" });
    expect((await openItems(db, user, a.id, "USD")).map((i) => [i.transactionId, i.status, i.remainingMinor])).toEqual([[t2, "partial", 2500]]);
    expect(await owed(db, a.id)).toBe(2500);
    expect(t1).toBeGreaterThan(0);
  });

  it("settle-all names every open item; friend-paid items count the other way", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    const t1 = await shared(db, a.id, 4000, "2026-08-02", "Costco");
    const fp = await createFriendPaidExpense(db, user, { payerId: a.id, totalMinor: 3000, currency: "USD", occurredAt: "2026-08-05", description: "Taxi" });
    const s = await settleAll(db, user, a.id, "USD", { settledOn: "2026-09-01" });
    expect(s.amountMinor).toBe(2000 - 1500);
    expect((await db.select().from(settlementItems).where(eq(settlementItems.settlementId, s.id))).map((r) => [r.transactionId, r.amountMinor])).toEqual([
      [t1, 2000],
      [fp.transactionId, -1500],
    ]);
    expect(await openItems(db, user, a.id, "USD")).toEqual([]);
  });

  it("an opening balance and a later settle-all leave nothing open", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    await recordOpeningBalance(db, user, { participantId: a.id, direction: "they_owe_me", amountMinor: 10000, currency: "USD", date: "2026-07-01" });
    await shared(db, a.id, 4000, "2026-08-02", "Costco");
    await settleAll(db, user, a.id, "USD", { settledOn: "2026-09-01" });
    const st = await statementText(db, user, a.id, "USD", { today: "2026-09-29" });
    expect(st).toMatchObject({ openItems: [], openOpeningMinor: 0, unmatchedMinor: 0, balanceMinor: 0 });
  });

  it("re-splitting a paid item hands the excess back as money paid ahead", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    const t1 = await shared(db, a.id, 4000, "2026-08-02", "Costco");
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 2000, currency: "USD", settledOn: "2026-09-01", itemTransactionIds: [t1] });
    await setSplit(db, user, t1, { participantIds: [a.id], mode: "exact", exact: [{ participantId: a.id, owedMinor: 1500 }] });
    const st = await statementText(db, user, a.id, "USD", { today: "2026-09-29" });
    expect(st).toMatchObject({ openItems: [], unmatchedMinor: -500, balanceMinor: -500 });
    expect(st.text).toContain("Paid ahead, not matched to an item: you sent me $5.00");
  });
});

describe("FX on settlements", () => {
  it("settle-all with a rate derives the amount received; with an amount derives the rate", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    await shared(db, a.id, 10000, "2026-08-02", "Costco");
    const s = await settleAll(db, user, a.id, "USD", { settledOn: "2026-09-01", originalCurrency: "CNY", fxRate: "7.2" });
    expect(s).toMatchObject({ amountMinor: 5000, originalAmountMinor: 36000, originalCurrency: "CNY", fxRate: "7.2" });

    await shared(db, a.id, 3000, "2026-09-02", "Cafe");
    const r = await recordSettlement(db, user, { participantId: a.id, amountMinor: 1500, currency: "USD", settledOn: "2026-09-03", originalAmountMinor: 10850, originalCurrency: "CNY" });
    expect(r).toMatchObject({ originalAmountMinor: 10850, fxRate: "7.23333333" });
    expect((await listSettlements(db, user, a.id))[0]).toMatchObject({ fxRate: "7.23333333" });

    const st = await statementText(db, user, a.id, "USD", { today: "2026-09-29" });
    expect(st.text).toContain("9/1 you sent me $50.00 (actually ¥360.00 at 7.2)");
    expect((await statementText(db, user, a.id, "USD", { today: "2026-09-29", locale: "zh-CN" })).text).toContain("09-01 你转我 $50.00（实际 ¥360.00，汇率 7.2）");

    // Same currency: no rate kept. A bad rate or a rate without a currency is refused.
    await shared(db, a.id, 3000, "2026-09-04", "Bar");
    expect((await recordSettlement(db, user, { participantId: a.id, amountMinor: 100, currency: "USD", settledOn: "2026-09-05", originalAmountMinor: 100, originalCurrency: "USD", fxRate: "1" })).fxRate).toBeNull();
    await expect(recordSettlement(db, user, { participantId: a.id, amountMinor: 100, currency: "USD", settledOn: "2026-09-05", originalCurrency: "CNY", fxRate: "-7" })).rejects.toThrow(expect.objectContaining({ code: "settlement_fx_rate_invalid" }));
    await expect(recordSettlement(db, user, { participantId: a.id, amountMinor: 100, currency: "USD", settledOn: "2026-09-05", fxRate: "7" })).rejects.toThrow(expect.objectContaining({ code: "settlement_original_incomplete" }));
  });

  it("mark as repayment converts the transfer by the rate into the balance currency", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    await shared(db, a.id, 20000, "2026-08-02", "Costco");
    const inbound = await addTx(db, 36000, "2026-09-01", "Transfer", "CNY");
    const s = await markAsSettlement(db, user, inbound, { participantId: a.id, currency: "USD", fxRate: "7.2" });
    expect(s).toMatchObject({ amountMinor: 5000, currency: "USD", originalAmountMinor: 36000, originalCurrency: "CNY", fxRate: "7.2" });
    const other = await addTx(db, 10000, "2026-09-02", "Transfer", "CNY");
    expect(await markAsSettlement(db, user, other, { participantId: a.id, currency: "USD", amountMinor: 1400 })).toMatchObject({ fxRate: "7.14285714" });
    expect(await owed(db, a.id)).toBe(10000 - 5000 - 1400);
  });
});

describe("shared notes", () => {
  it("sets, trims, clears, and shows on the statement", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    const t1 = await shared(db, a.id, 4000, "2026-08-02", "Costco");
    expect((await getSharedNote(db, user, t1)).sharedNote).toBeNull();
    expect((await setSharedNote(db, user, t1, "  paper towels too  ")).sharedNote).toBe("paper towels too");
    expect((await openItems(db, user, a.id, "USD"))[0]!.sharedNote).toBe("paper towels too");
    const st = await statementText(db, user, a.id, "USD", { today: "2026-09-29" });
    expect(st.text).toContain("8/2 Costco $40.00, your share $20.00\n  Note: paper towels too");
    // The private note never reaches the statement.
    await db.update(transactions).set({ note: "private" }).where(eq(transactions.id, t1));
    expect((await statementText(db, user, a.id, "USD", { today: "2026-09-29" })).text).not.toContain("private");
    expect((await setSharedNote(db, user, t1, "")).sharedNote).toBeNull();
    await expect(setSharedNote(db, user, t1, "x".repeat(501))).rejects.toThrow(expect.objectContaining({ code: "shared_note_too_long" }));
    await expect(setSharedNote(db, user, 9999, "x")).rejects.toThrow(expect.objectContaining({ code: "transaction_not_found" }));
  });
});

describe("statement scope", () => {
  /** Alex: Costco (FIFO-covered by a legacy settlement), Cafe (named by a settlement), Bar (open). Li: Deli. */
  async function ledger() {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    const li = await createParticipant(db, user, "Li");
    const costco = await shared(db, a.id, 4000, "2026-08-02", "Costco");
    const cafe = await shared(db, a.id, 3000, "2026-08-10", "Cafe");
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 2000, currency: "USD", settledOn: "2026-08-20" });
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 1500, currency: "USD", settledOn: "2026-09-10", itemTransactionIds: [cafe] });
    const bar = await shared(db, a.id, 2000, "2026-09-12", "Bar");
    const cny = await shared(db, a.id, 5000, "2026-09-13", "Hotpot", "CNY");
    const deli = await shared(db, li.id, 1000, "2026-09-14", "Deli");
    return { db, a, costco, cafe, bar, cny, deli };
  }
  const opts = { today: "2026-09-29" } as const;

  it("open (default) lists only open items and keeps the text as before", async () => {
    const { db, a, bar } = await ledger();
    const st = await statementText(db, user, a.id, "USD", opts);
    expect(st.scope).toBe("open");
    expect(st.scopeItems.map((e) => e.transactionId)).toEqual([bar]);
    expect(st).toMatchObject({ scopeRemainingMinor: 1000, scopeDeltaMinor: 1000 });
    expect(st.text).not.toContain("Already settled");
    expect(st.text.split("\n")[1]).toBe("");
  });

  it("all shows settled items with the day they were settled, from item rows and legacy FIFO coverage", async () => {
    const { db, a, costco, cafe, bar } = await ledger();
    const st = await statementText(db, user, a.id, "USD", { ...opts, scope: "all" });
    expect(st.scopeItems.map((e) => [e.transactionId, e.status, e.settledOn])).toEqual([
      [costco, "covered", "2026-08-20"],
      [cafe, "covered", "2026-09-10"],
      [bar, "open", null],
    ]);
    expect(st).toMatchObject({ scopeRemainingMinor: 1000, scopeDeltaMinor: 4500 });
    expect(st.text).toContain("All items");
    expect(st.text).toContain("Already settled:\n8/2 Costco $40.00, your share $20.00 (settled on 8/20)");
    expect(st.text).toContain("Settled recently:");
    const zh = (await statementText(db, user, a.id, "USD", { ...opts, scope: "all", locale: "zh-CN" })).text;
    expect(zh).toContain("已结清：\n08-02 Costco 共$40.00，你的份额 $20.00（08-20 已结清）");
    // The CSV window widens to the whole history.
    expect(st.items.map((i) => i.transactionId)).toEqual([costco, cafe, bar]);
  });

  it("selected lists the chosen items, open and settled, with their own total", async () => {
    const { db, a, costco, bar } = await ledger();
    const st = await statementText(db, user, a.id, "USD", { ...opts, scope: "selected", itemIds: [bar, costco] });
    expect(st.scopeItems.map((e) => e.transactionId)).toEqual([costco, bar]);
    expect(st).toMatchObject({ scopeRemainingMinor: 1000, scopeDeltaMinor: 3000, balanceMinor: 1000 });
    expect(st.text).toContain("Selected 2 items");
    expect(st.text).toContain("These items: you owe me $10.00");
    expect(st.text).not.toContain("Settled recently");
    expect((await statementText(db, user, a.id, "USD", { ...opts, scope: "selected", itemIds: [bar], locale: "zh-CN" })).text).toContain("所选 1 笔");
  });

  it("selected rejects ids that are not this person's items in this currency, and an empty selection", async () => {
    const { db, a, bar, cny, deli } = await ledger();
    for (const bad of [[bar, deli], [cny], [999999]]) {
      await expect(statementText(db, user, a.id, "USD", { ...opts, scope: "selected", itemIds: bad })).rejects.toThrow(expect.objectContaining({ code: "statement_items_invalid" }));
    }
    await expect(statementText(db, user, a.id, "USD", { ...opts, scope: "selected", itemIds: [] })).rejects.toThrow(expect.objectContaining({ code: "statement_items_required" }));
  });

  it("an item netted against one they paid is settled on the later item's day", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    const t1 = await shared(db, a.id, 3000, "2026-08-02", "Groceries");
    const fp = await createFriendPaidExpense(db, user, { payerId: a.id, totalMinor: 3000, currency: "USD", occurredAt: "2026-08-05", description: "Taxi" });
    const st = await statementText(db, user, a.id, "USD", { ...opts, scope: "all" });
    expect(st.entries.map((e) => [e.transactionId, e.settledOn])).toEqual([
      [t1, "2026-08-05"],
      [fp.transactionId, "2026-08-05"],
    ]);
  });
});

describe("statement options", () => {
  /** Alex and Li share Groceries three ways (with a note); Alex alone shares a Cafe, which Alex paid back. */
  async function ledger() {
    const db = await freshDb();
    const a = await createParticipant(db, user, "Alex");
    const li = await createParticipant(db, user, "Li");
    const groceries = (await db.select().from(categories).where(eq(categories.name, "买菜")).limit(1))[0]!.id;
    const market = await addTx(db, -3000, "2026-09-02", "Market");
    await db.update(transactions).set({ categoryId: groceries }).where(eq(transactions.id, market));
    await setSplit(db, user, market, { participantIds: [a.id, li.id], mode: "equal" });
    await setSharedNote(db, user, market, "eggs too");
    const cafe = await shared(db, a.id, 2000, "2026-09-05", "Cafe");
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 1000, currency: "USD", settledOn: "2026-09-10", itemTransactionIds: [cafe] });
    return { db, a };
  }
  const opts = { today: "2026-09-29", scope: "all" } as const;
  const lineOf = (text: string, merchant: string) => text.split("\n").find((l) => l.includes(merchant))!;

  it("defaults: count only for items someone else shares, notes, settlements and payment info; no names, my share or category", async () => {
    const { db, a } = await ledger();
    const st = await statementText(db, user, a.id, "USD", opts);
    expect(st.show).toEqual(["shared", "notes", "settlements", "payment"]);
    expect(lineOf(st.text, "Market")).toBe("9/2 Market $30.00, your share $10.00, split 3 ways");
    expect(lineOf(st.text, "Cafe")).toBe("9/5 Cafe $20.00, your share $10.00 (settled on 9/10)");
    expect(st.text).toContain("  Note: eggs too");
    expect(st.text).toContain("Settled recently:\n9/10 you sent me $10.00");
    expect(st.text).not.toContain("Li");
    expect(st.entries[0]).toMatchObject({ splitCount: 3, sharedWith: ["Li"], myShareMinor: 1000, category: "买菜" });
  });

  it("names lists the others (and implies shared) in both languages", async () => {
    const { db, a } = await ledger();
    const en = await statementText(db, user, a.id, "USD", { ...opts, show: ["names"] });
    expect(en.show).toEqual(["shared", "names"]);
    expect(lineOf(en.text, "Market")).toBe("9/2 Market $30.00, your share $10.00, split 3 ways (with Li)");
    const zh = (await statementText(db, user, a.id, "USD", { ...opts, show: ["shared", "names"], locale: "zh-CN" })).text;
    expect(lineOf(zh, "Market")).toBe("09-02 Market 共$30.00，你的份额 $10.00，3 人分摊（和 Li）");
  });

  it("my share and category, in both languages", async () => {
    const { db, a } = await ledger();
    const en = (await statementText(db, user, a.id, "USD", { ...opts, show: ["myshare", "category"] })).text;
    expect(lineOf(en, "Market")).toBe("9/2 Market [Groceries] $30.00, your share $10.00, my share $10.00");
    const zh = (await statementText(db, user, a.id, "USD", { ...opts, show: ["myshare", "category"], locale: "zh-CN" })).text;
    expect(lineOf(zh, "Market")).toBe("09-02 Market［买菜］ 共$30.00，你的份额 $10.00，我的份额 $10.00");
  });

  it("my share carries the display name once it is set, and falls back when cleared", async () => {
    const { db, a } = await ledger();
    expect((await statementText(db, user, a.id, "USD", opts)).myName).toBeNull();
    await setDisplayName(db, user, "Sam");
    const en = await statementText(db, user, a.id, "USD", { ...opts, show: ["myshare"] });
    expect(en.myName).toBe("Sam");
    expect(lineOf(en.text, "Market")).toBe("9/2 Market $30.00, your share $10.00, Sam's share $10.00");
    const zh = (await statementText(db, user, a.id, "USD", { ...opts, show: ["myshare"], locale: "zh-CN" })).text;
    expect(lineOf(zh, "Market")).toBe("09-02 Market 共$30.00，你的份额 $10.00，Sam的份额 $10.00");
    await setDisplayName(db, user, "");
    expect(lineOf((await statementText(db, user, a.id, "USD", { ...opts, show: ["myshare"] })).text, "Market")).toContain(", my share $10.00");
  });

  it("none: no split count, notes or settlements", async () => {
    const { db, a } = await ledger();
    const st = await statementText(db, user, a.id, "USD", { ...opts, show: [] });
    expect(st.show).toEqual([]);
    expect(lineOf(st.text, "Market")).toBe("9/2 Market $30.00, your share $10.00");
    expect(st.text).not.toContain("eggs too");
    expect(st.text).not.toContain("Settled recently");
    expect(st.text).toContain("Total: you owe me $10.00");
  });
});
