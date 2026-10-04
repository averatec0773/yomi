import { accounts, type Db, investmentAccounts, investmentTransactions, transactions } from "@yomi/db";
import type { NormalizedRow, ParseResult } from "@yomi/importers";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { confirmOwnTransfers, listReview, resolveTransactionReview, undoTransactionReview } from "../capture";
import { addParticipant, addSplit, addTx, catId, freshDb, selfId, user } from "../ledger/test-helpers";
import { updateTransaction } from "../ledger/update";
import { addIdentity } from "../split/identities";
import { commitParsed, revertBatch } from "./pipeline";
import { applyNewTransfers, detectOwnTransfers, revertOwnTransfer } from "./transfers";

// Fictional: own name Sam Rivera, friends Jordan Park and Avery Lin, cards 3141 (BoA checking) and 5501 (Chase savings).

async function setup() {
  const db = await freshDb();
  const acct = async (name: string, institution: string, last4: string) =>
    (await db.insert(accounts).values({ userId: user.id, name, kind: "debit_card", institution, last4, currency: "USD" }).returning())[0]!.id;
  return { db, boa: await acct("BoA checking", "Bank of America", "3141"), chase: await acct("Chase savings", "Chase", "5501") };
}

type Leg = Parameters<typeof addTx>[1];
const usd = (p: Leg): Leg => ({ currency: "USD", source: "boa_csv", ...p });
const day = (d: string) => `2026-09-${d}T12:00:00+08:00`;
const row = async (db: Db, id: number) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0]!;

describe("own-account transfer detection", () => {
  it("a unique opposite pair across two of my accounts is high, the incoming leg first", async () => {
    const { db, boa, chase } = await setup();
    const out = await addTx(db, usd({ accountId: boa, amountMinor: -50000, sourceCategory: "ACH", counterpartyRaw: "CHASE DES:TRANSFER", occurredAt: day("10") }));
    const inn = await addTx(db, usd({ accountId: chase, source: "plaid", amountMinor: 50000, sourceCategory: "TRANSFER_IN/TRANSFER_IN_ACCOUNT_TRANSFER", counterpartyRaw: "ONLINE TRANSFER FROM BOA", occurredAt: day("11") }));
    expect(await detectOwnTransfers(db, user)).toEqual([{ transactionId: inn, peerId: out, rule: "pair", confidence: "high", reasons: ["pair", "bank"] }]);
  });

  it("near misses: two candidate legs is medium (nearest day); same account, 4+ days apart or a purchase leg is nothing", async () => {
    const { db, boa, chase } = await setup();
    const out = await addTx(db, usd({ accountId: boa, amountMinor: -20000, sourceCategory: "Transfer", counterpartyRaw: "Online Banking transfer to SAV 5501", occurredAt: day("10") }));
    await addTx(db, usd({ accountId: chase, amountMinor: 20000, counterpartyRaw: "TRANSFER FROM CHK", occurredAt: day("12") }));
    const near = await addTx(db, usd({ accountId: chase, amountMinor: 20000, counterpartyRaw: "TRANSFER FROM CHK", occurredAt: day("11") }));
    // Same account in and out.
    await addTx(db, usd({ accountId: boa, amountMinor: -7000, sourceCategory: "ACH", counterpartyRaw: "ACME DES:ACH", occurredAt: day("05") }));
    await addTx(db, usd({ accountId: boa, amountMinor: 7000, sourceCategory: "ACH", counterpartyRaw: "ACME DES:ACH", occurredAt: day("05") }));
    // Same amount, different day (4 days apart).
    await addTx(db, usd({ accountId: boa, amountMinor: -9100, sourceCategory: "ACH", counterpartyRaw: "CHASE DES:ACH", occurredAt: day("01") }));
    await addTx(db, usd({ accountId: chase, amountMinor: 9100, counterpartyRaw: "ACH TRANSFER", occurredAt: day("05") }));
    // A refund and a purchase of the same amount are not a transfer.
    await addTx(db, usd({ accountId: boa, amountMinor: -4500, sourceCategory: "Purchase", counterpartyRaw: "TARGET 0042", occurredAt: day("15") }));
    await addTx(db, usd({ accountId: chase, amountMinor: 4500, kind: "refund", counterpartyRaw: "TARGET 0042", occurredAt: day("15") }));
    expect(await detectOwnTransfers(db, user)).toEqual([{ transactionId: near, peerId: out, rule: "pair", confidence: "medium", reasons: ["pair", "pairs"] }]);
  });

  it("my name as sender is high; a friend's name is not a transfer", async () => {
    const { db, boa } = await setup();
    await addIdentity(db, user, await selfId(db), { kind: "bank_name", value: "Sam Rivera" });
    await addIdentity(db, user, await selfId(db), { kind: "zelle_name", value: "Sam Rivera" });
    const friend = await addParticipant(db, "Avery Lin");
    await addIdentity(db, user, friend, { kind: "bank_name", value: "AVERY LIN" });
    const wire = await addTx(db, usd({ accountId: boa, amountMinor: 300000, sourceCategory: "Wire", counterpartyRaw: "SAM RIVERA", descriptionRaw: "WIRE TYPE:INTL IN DATE:260910 ORIG:1/SAM RIVERA ID:123" }));
    const zelle = await addTx(db, usd({ accountId: boa, amountMinor: 4000, sourceCategory: "Zelle", counterpartyRaw: "Sam  Rivera" }));
    await addTx(db, usd({ accountId: boa, amountMinor: 250000, sourceCategory: "Wire", counterpartyRaw: "AVERY LIN", descriptionRaw: "WIRE TYPE:INTL IN ORIG:1/AVERY LIN ID:9" }));
    await addTx(db, usd({ accountId: boa, amountMinor: 2500, sourceCategory: "Zelle", counterpartyRaw: "Jordan Park" }));
    expect(await detectOwnTransfers(db, user)).toEqual([
      { transactionId: wire, peerId: null, rule: "own_name", confidence: "high", reasons: ["name"] },
      { transactionId: zelle, peerId: null, rule: "own_name", confidence: "high", reasons: ["name"] },
    ]);
  });

  it("a brokerage ACH with the brokerage's own transfer within 5 days is high; broker text alone is medium", async () => {
    const { db, boa } = await setup();
    const ib = (await db.insert(investmentAccounts).values({ userId: user.id, provider: "ibkr", externalId: "U0000001", name: "IBKR", currency: "USD" }).returning())[0]!.id;
    await db.insert(investmentTransactions).values({ userId: user.id, investmentAccountId: ib, externalId: "t1", date: "2026-09-14", type: "transfer", amountMinor: 100000, currency: "USD" });
    const matched = await addTx(db, usd({ accountId: boa, amountMinor: -100000, sourceCategory: "ACH", counterpartyRaw: "INTERACTIVE BROKERS DES:ACH ID:1", occurredAt: day("10") }));
    const alone = await addTx(db, usd({ accountId: boa, amountMinor: -2000, sourceCategory: "ACH", counterpartyRaw: "INTERACTIVE BR DES:ACH ID:2", occurredAt: day("20") }));
    expect(await detectOwnTransfers(db, user)).toEqual([
      { transactionId: matched, peerId: null, rule: "broker", confidence: "high", reasons: ["broker", "investment"] },
      { transactionId: alone, peerId: null, rule: "broker", confidence: "medium", reasons: ["broker"] },
    ]);
  });

  it("an unpaired Plaid transfer is a medium hint; app transfers, card payments, edited, split and dismissed rows are not proposed", async () => {
    const { db, boa } = await setup();
    const wire = await addTx(db, usd({ accountId: boa, source: "plaid", kind: "transfer", amountMinor: 500000, sourceCategory: "TRANSFER_IN/TRANSFER_IN_WIRE", counterpartyRaw: "WIRE IN" }));
    await addTx(db, usd({ accountId: boa, source: "plaid", amountMinor: 2000, sourceCategory: "TRANSFER_IN/TRANSFER_IN_FROM_APPS", counterpartyRaw: "Zelle from Jordan Park" }));
    await addTx(db, usd({ accountId: boa, source: "plaid", kind: "transfer", amountMinor: -80000, sourceCategory: "LOAN_PAYMENTS/LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", counterpartyRaw: "CARD PAYMENT" }));
    await addTx(db, usd({ accountId: boa, source: "plaid", kind: "transfer", amountMinor: 600000, sourceCategory: "TRANSFER_IN/TRANSFER_IN_WIRE", userEditedAt: "2026-09-20T00:00:00Z" }));
    await addTx(db, usd({ accountId: boa, source: "plaid", kind: "transfer", amountMinor: 700000, sourceCategory: "TRANSFER_IN/TRANSFER_IN_WIRE", reviewDismissedAt: "2026-09-20T00:00:00Z" }));
    const split = await addTx(db, usd({ accountId: boa, amountMinor: -3000, sourceCategory: "Zelle", counterpartyRaw: "Jordan Park" }));
    await addSplit(db, split, await addParticipant(db, "Jordan Park"), 1500, 0, "USD");
    expect(await detectOwnTransfers(db, user)).toEqual([{ transactionId: wire, peerId: null, rule: "hint", confidence: "medium", reasons: ["bank"] }]);
  });
});

describe("applying and taking back own-account transfers", () => {
  async function pair() {
    const s = await setup();
    const out = await addTx(s.db, usd({ accountId: s.boa, amountMinor: -50000, sourceCategory: "ACH", counterpartyRaw: "CHASE DES:TRANSFER", occurredAt: day("10") }));
    const inn = await addTx(s.db, usd({ accountId: s.chase, amountMinor: 50000, counterpartyRaw: "ONLINE TRANSFER FROM BOA", occurredAt: day("10") }));
    return { ...s, out, inn };
  }

  it("applies to new rows only, links both legs with the rule and prior kind; Undo restores; Not a transfer is never reapplied", async () => {
    const { db, out, inn } = await pair();
    expect(await applyNewTransfers(db, user, [9999])).toBe(0);
    expect(await applyNewTransfers(db, user, [inn])).toBe(2);
    expect(await row(db, inn)).toMatchObject({ kind: "transfer", priorKind: "income", kindRule: "pair", transferPeerId: out, userEditedAt: null });
    expect(await row(db, out)).toMatchObject({ kind: "transfer", priorKind: "expense", kindRule: "pair", transferPeerId: inn });
    expect(await detectOwnTransfers(db, user)).toEqual([]);

    expect((await revertOwnTransfer(db, user, out, { dismiss: false })).sort()).toEqual([out, inn].sort());
    expect(await row(db, inn)).toMatchObject({ kind: "income", priorKind: null, kindRule: null, transferPeerId: null, userEditedAt: null });
    expect(await detectOwnTransfers(db, user)).toHaveLength(1);

    await applyNewTransfers(db, user, [inn]);
    await revertOwnTransfer(db, user, inn, { dismiss: true });
    expect(await row(db, out)).toMatchObject({ kind: "expense", kindRule: null, userEditedAt: expect.any(String), reviewDismissedAt: expect.any(String) });
    expect(await applyNewTransfers(db, user, [inn, out])).toBe(0);
    expect(await detectOwnTransfers(db, user)).toEqual([]);
  });

  it("editing one leg's kind ends the transfer and gives the other leg its kind back", async () => {
    const { db, out, inn } = await pair();
    await applyNewTransfers(db, user, [inn]);
    await updateTransaction(db, user, inn, { kind: "income" });
    expect(await row(db, inn)).toMatchObject({ kind: "income", kindRule: null, transferPeerId: null });
    expect(await row(db, out)).toMatchObject({ kind: "expense", kindRule: null, transferPeerId: null, priorKind: null });
  });

  it("history is only queued (no kind changes); an import applies high pairs with the new rows, and reverting it restores the kept leg", async () => {
    const { db, chase, boa } = await setup();
    const old = await addTx(db, usd({ accountId: chase, amountMinor: 50000, counterpartyRaw: "ONLINE TRANSFER FROM BOA", occurredAt: day("10") }));
    const histOut = await addTx(db, usd({ accountId: boa, amountMinor: -1200, sourceCategory: "ACH", counterpartyRaw: "CHASE DES:TRANSFER", occurredAt: day("02") }));
    const histIn = await addTx(db, usd({ accountId: chase, amountMinor: 1200, counterpartyRaw: "TRANSFER FROM BOA", occurredAt: day("02") }));
    const queue = await listReview(db, user, { today: "2026-09-30" });
    expect(queue.counts.own_transfer).toBe(1);
    expect(queue.items).toEqual([expect.objectContaining({ subject: "transaction", type: "own_transfer", transactionId: histIn, peer: expect.objectContaining({ transactionId: histOut, accountName: "BoA checking" }) })]);
    expect((await row(db, histIn)).kind).toBe("income");

    const r: NormalizedRow = {
      source: "boa_csv", lineNo: 1, externalId: null, occurredAt: day("11"), amountMinor: -50000, currency: "USD", originalAmountMinor: null, originalCurrency: null,
      direction: "out", kind: "expense", status: "ok", counterparty: "CHASE DES:TRANSFER", description: "", sourceCategory: "ACH", paymentMethod: null, raw: { note: "synthetic" },
    };
    const parsed: ParseResult = { source: "boa_csv", rows: [r], declared: {}, warnings: [] };
    const res = await commitParsed(db, user, parsed, { fileHash: "h1", fileName: "boa.csv", backup: false, noDeclared: true });
    expect(res.ownTransfers).toBe(2);
    expect(await row(db, old)).toMatchObject({ kind: "transfer", kindRule: "pair", priorKind: "income" });
    expect((await row(db, histIn)).kind).toBe("income");

    await revertBatch(db, user, res.batchId, { backup: false });
    expect(await row(db, old)).toMatchObject({ kind: "income", kindRule: null, transferPeerId: null });
  });
});

describe("own_transfer review actions", () => {
  it("confirm, undo, dismiss, undo; income on a Plaid wire hint; bulk confirm", async () => {
    const { db, boa, chase } = await setup();
    const today = "2026-09-30";
    const out = await addTx(db, usd({ accountId: boa, amountMinor: -50000, sourceCategory: "ACH", counterpartyRaw: "CHASE DES:TRANSFER", occurredAt: day("10") }));
    const inn = await addTx(db, usd({ accountId: chase, amountMinor: 50000, counterpartyRaw: "ONLINE TRANSFER FROM BOA", occurredAt: day("10") }));
    const wire = await addTx(db, usd({ accountId: boa, source: "plaid", kind: "transfer", amountMinor: 500000, sourceCategory: "TRANSFER_IN/TRANSFER_IN_WIRE", counterpartyRaw: "WIRE IN", occurredAt: day("12") }));
    expect((await listReview(db, user, { today })).counts.own_transfer).toBe(2);

    const done = await resolveTransactionReview(db, user, inn, { action: "own_transfer" });
    expect(done).toEqual({ transactionId: inn, kind: "transfer", prior: { kind: "income", categoryId: null, userEditedAt: null, reviewDismissedAt: null }, settlementId: null });
    expect(await row(db, out)).toMatchObject({ kind: "transfer", transferPeerId: inn, userEditedAt: expect.any(String) });
    expect((await listReview(db, user, { today })).counts.own_transfer).toBe(1);
    await undoTransactionReview(db, user, inn, { action: "own_transfer", prior: done.prior });
    expect(await row(db, out)).toMatchObject({ kind: "expense", transferPeerId: null, userEditedAt: null });

    const dismissed = await resolveTransactionReview(db, user, inn, { action: "dismiss" });
    expect((await listReview(db, user, { today })).counts.own_transfer).toBe(1);
    await undoTransactionReview(db, user, inn, { action: "dismiss", prior: dismissed.prior });
    expect((await listReview(db, user, { today })).counts.own_transfer).toBe(2);

    const family = await catId(db, "家人资助");
    await expect(resolveTransactionReview(db, user, wire, { action: "income", categoryId: await catId(db, "餐饮") })).rejects.toMatchObject({ code: "review_income_category" });
    const income = await resolveTransactionReview(db, user, wire, { action: "income", categoryId: family });
    expect(await row(db, wire)).toMatchObject({ kind: "income", categoryId: family, reviewDismissedAt: expect.any(String) });
    await undoTransactionReview(db, user, wire, { action: "income", prior: income.prior });
    expect(await row(db, wire)).toMatchObject({ kind: "transfer", categoryId: null, userEditedAt: null, reviewDismissedAt: null });

    expect(await confirmOwnTransfers(db, user, [inn, wire])).toEqual([
      expect.objectContaining({ transactionId: inn, kind: "transfer" }),
      expect.objectContaining({ transactionId: wire, kind: "transfer" }),
    ]);
    expect(await row(db, wire)).toMatchObject({ kind: "transfer", kindRule: "hint", priorKind: null });
    expect((await listReview(db, user, { today })).counts.own_transfer).toBe(0);
    await expect(resolveTransactionReview(db, user, inn, { action: "own_transfer" })).rejects.toMatchObject({ code: "review_item_gone" });
  });

  it("me holds only the names on my transfers", async () => {
    const { db } = await setup();
    await expect(addIdentity(db, user, await selfId(db), { kind: "zelle_email", value: "sam@example.com" })).rejects.toMatchObject({ code: "identity_self_kind" });
    expect(await addIdentity(db, user, await selfId(db), { kind: "alipay", value: "Sam Rivera" })).toMatchObject({ kind: "alipay", value: "Sam Rivera" });
  });
});
