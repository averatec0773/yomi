import { accounts, type Db, transactions } from "@yomi/db";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { listReview, resolveTransactionReview } from "../capture";
import { addTx, freshDb, user } from "../ledger/test-helpers";
import { createParticipant } from "./participants";
import { repaymentProposals } from "./repayments";
import { deleteSettlement, recordSettlement } from "./settlements";
import { toggleParticipant } from "./splits";
import { openItems } from "./items";

// Fictional people: Jordan Park, Avery Lin, an unknown Morgan Lee; card 3141.
const today = "2026-09-30";
const day = (d: string) => `2026-09-${d}T12:00:00+08:00`;

async function setup() {
  const db = await freshDb();
  const wallet = (await db.insert(accounts).values({ userId: user.id, name: "BoA checking", kind: "debit_card", institution: "Bank of America", last4: "3141", currency: "USD" }).returning())[0]!.id;
  const jordan = (await createParticipant(db, user, "Jordan Park", [{ kind: "zelle_name", value: "Jordan Park" }, { kind: "wechat", value: "jordan_p" }])).id;
  return { db, wallet, jordan };
}

/** An expense I paid, split equally with `pid`: they owe half of `total`. */
async function owes(db: Db, wallet: number, pid: number, total: number, d: string, merchant = "Corner Cafe") {
  const id = await addTx(db, { accountId: wallet, amountMinor: -total, currency: "USD", source: "manual", merchant, occurredAt: day(d) });
  await toggleParticipant(db, user, id, pid);
  return id;
}

const zelle = (db: Db, wallet: number, from: string, amountMinor: number, d: string) =>
  addTx(db, { accountId: wallet, amountMinor, currency: "USD", source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: from, merchant: from, occurredAt: d.length === 2 ? day(d) : d });

const only = async (db: Db) => (await repaymentProposals(db, user, { today })).map((m) => ({ id: m.transactionId, ...m.proposal }));

describe("repayment proposals", () => {
  it("the exact balance from the person is high and pays every open item", async () => {
    const { db, wallet, jordan } = await setup();
    const a = await owes(db, wallet, jordan, 4000, "01");
    const b = await owes(db, wallet, jordan, 2000, "03");
    const pay = await zelle(db, wallet, "Jordan Park", 3000, "10");
    expect(await only(db)).toEqual([
      expect.objectContaining({ id: pay, participantId: jordan, participantName: "Jordan Park", itemTransactionIds: [a, b], amountMinor: 3000, currency: "USD", balanceAfterMinor: 0, confidence: "high", reasons: ["name", "balance", "time"], possiblyCovered: null }),
    ]);
  });

  it("the oldest items in order, or a unique set of items, is high with the item ids", async () => {
    const { db, wallet, jordan } = await setup();
    const a = await owes(db, wallet, jordan, 2000, "01");
    const b = await owes(db, wallet, jordan, 5000, "02");
    const c = await owes(db, wallet, jordan, 1400, "03");
    const d = await owes(db, wallet, jordan, 800, "04");
    // Open: 1000, 2500, 700, 400 (balance 4600). 3500 = the two oldest; 2100 = 1000 + 700 + 400 and nothing else.
    const prefix = await zelle(db, wallet, "Jordan Park", 3500, "10");
    expect(await only(db)).toEqual([expect.objectContaining({ id: prefix, itemTransactionIds: [a, b], reasons: ["name", "items", "time"], confidence: "high" })]);
    await db.delete(transactions).where(eq(transactions.id, prefix));
    const subset = await zelle(db, wallet, "Jordan Park", 2100, "10");
    expect(await only(db)).toEqual([expect.objectContaining({ id: subset, itemTransactionIds: [a, c, d], balanceAfterMinor: 2500, confidence: "high" })]);
  });

  it("an ambiguous set of items or a partial payment is medium without items", async () => {
    const { db, wallet, jordan } = await setup();
    await owes(db, wallet, jordan, 1400, "01");
    await owes(db, wallet, jordan, 600, "02");
    await owes(db, wallet, jordan, 1000, "03");
    await owes(db, wallet, jordan, 1000, "04");
    // Open: 700, 300, 500, 500. 500 is either of two items.
    const ambiguous = await zelle(db, wallet, "Jordan Park", 500, "10");
    const partial = await zelle(db, wallet, "Jordan Park", 1100, "11");
    expect(await only(db)).toEqual([
      expect.objectContaining({ id: partial, itemTransactionIds: [], reasons: ["name", "partial", "time"], confidence: "medium", balanceAfterMinor: 900 }),
      expect.objectContaining({ id: ambiguous, itemTransactionIds: [], reasons: ["name", "partial", "time"], confidence: "medium" }),
    ]);
  });

  it("a looser name match with the balance is medium; an unknown sender equal to one person's balance suggests that person", async () => {
    const { db, wallet, jordan } = await setup();
    const avery = (await createParticipant(db, user, "Avery Lin")).id;
    await owes(db, wallet, avery, 3000, "01");
    await owes(db, wallet, jordan, 5000, "02");
    const contains = await zelle(db, wallet, "AVERY LIN SMITH", 1500, "10");
    const unknown = await zelle(db, wallet, "Morgan Lee", 2500, "11");
    expect(await only(db)).toEqual([
      expect.objectContaining({ id: unknown, participantId: jordan, reasons: ["balance", "time"], confidence: "medium" }),
      expect.objectContaining({ id: contains, participantId: avery, reasons: ["balance", "time"], confidence: "medium" }),
    ]);
  });

  it("nothing for a payment dated before the item or larger than the balance", async () => {
    const { db, wallet, jordan } = await setup();
    await owes(db, wallet, jordan, 3000, "10");
    await zelle(db, wallet, "Jordan Park", 1500, "2026-09-05T12:00:00+08:00");
    await zelle(db, wallet, "Jordan Park", 9000, "12");
    expect(await only(db)).toEqual([]);
  });

  it("carries a settlement recorded by hand, and compares a CNY transfer with a USD balance at the last rate", async () => {
    const { db, wallet, jordan } = await setup();
    await owes(db, wallet, jordan, 8000, "01");
    await recordSettlement(db, user, { participantId: jordan, amountMinor: 1000, currency: "USD", originalAmountMinor: 7200, originalCurrency: "CNY", settledOn: "2026-09-05" });
    const manual = await recordSettlement(db, user, { participantId: jordan, amountMinor: 500, currency: "USD", settledOn: "2026-09-20" });
    const covered = await zelle(db, wallet, "Jordan Park", 500, "21");
    const yuan = await addTx(db, { amountMinor: 18000, currency: "CNY", source: "wechat", sourceCategory: "转账", counterpartyRaw: "jordan_p", merchant: "jordan_p", occurredAt: day("22") });
    // Open after both settlements: 4000 − 1000 − 500 = 2500 USD; ¥18000 at 1000/7200 = $25.00.
    expect(await only(db)).toEqual([
      expect.objectContaining({ id: yuan, amountMinor: 2500, currency: "USD", reasons: ["name", "balance", "time", "fx"], confidence: "high" }),
      expect.objectContaining({ id: covered, confidence: "medium", possiblyCovered: expect.objectContaining({ settlementId: manual.id, amountMinor: 500 }) }),
    ]);
  });

  it("review: Settle pays the items and flips the row; deleting the settlement undoes it; Not a repayment is never proposed again", async () => {
    const { db, wallet, jordan } = await setup();
    const a = await owes(db, wallet, jordan, 4000, "01");
    const pay = await zelle(db, wallet, "Jordan Park", 2000, "10");
    const queue = await listReview(db, user, { today });
    expect(queue.counts.repayment).toBe(1);
    expect(queue.items[0]).toMatchObject({ subject: "transaction", type: "repayment", transactionId: pay, row: { merchant: "Jordan Park", accountName: "BoA checking" } });

    const settled = await resolveTransactionReview(db, user, pay, { action: "settle", participantId: jordan, itemTransactionIds: [a] });
    expect(settled).toMatchObject({ transactionId: pay, kind: "transfer", settlementId: expect.any(Number) });
    expect(await openItems(db, user, jordan, "USD")).toEqual([]);
    expect((await listReview(db, user, { today })).total).toBe(0);
    await deleteSettlement(db, user, settled.settlementId!);
    expect((await db.select().from(transactions).where(eq(transactions.id, pay)))[0]!.kind).toBe("income");
    expect((await listReview(db, user, { today })).counts.repayment).toBe(1);

    await resolveTransactionReview(db, user, pay, { action: "dismiss" });
    expect(await only(db)).toEqual([]);
    expect((await listReview(db, user, { today })).total).toBe(0);
  });
});
