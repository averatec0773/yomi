import { accounts, categories, type Db, merchantRules, settlements, transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { seed } from "../seed";
import { setPaymentMethods } from "../settings/payment";
import { DEFAULT_TIME_ZONE, occurredOnFor } from "../time/zone";
import { getCurrentUser } from "../user";
import {
  archiveParticipant,
  balances,
  bulkToggle,
  createFriendPaidExpense,
  createParticipant,
  clearBefore,
  deleteSettlement,
  getSplit,
  listIdentities,
  listParticipants,
  listSettlements,
  markAsSettlement,
  recordOpeningBalance,
  recordSettlement,
  renameParticipant,
  setSplit,
  settleAll,
  settlementCandidates,
  SplitError,
  statementText,
  toggleParticipant,
  toggleParticipantResult,
  unsplitSuggestions,
} from "./index";

const user = getCurrentUser();

async function freshDb(): Promise<{ db: Db; accountId: number }> {
  const db = await testDb();
  await seed(db);
  const acct = (await db
    .insert(accounts)
    .values({ userId: user.id, name: "微信零钱", kind: "wallet", institution: "微信", currency: "CNY" })
    .returning())[0]!;
  return { db, accountId: acct.id };
}

let seq = 0;

async function addTx(
  db: Db,
  p: Partial<typeof transactions.$inferInsert> & { amountMinor: number },
): Promise<number> {
  seq += 1;
  return (await db
    .insert(transactions)
    .values({
      userId: user.id,
      accountId: 1,
      occurredAt: "2026-09-10T12:00:00+08:00",
      currency: "CNY",
      kind: p.amountMinor < 0 ? "expense" : "income",
      merchant: `商户${seq}`,
      source: "wechat",
      dedupKey: `test:${seq}`,
      ...p,
    })
    .returning({ id: transactions.id }))[0]!.id;
}

async function catId(db: Db, name: string): Promise<number> {
  return (await db.select().from(categories).where(eq(categories.name, name)).limit(1))[0]!.id;
}

async function bal(db: Db, pid: number, currency: string) {
  return (await balances(db, user)).find((b) => b.participantId === pid && b.currency === currency);
}

const selfId = async (db: Db) => (await listParticipants(db, user))[0]!.id;
const wx = (value: string) => ({ kind: "wechat" as const, value });

describe("participants", () => {
  it("creates with identities, renames, archives; names unique; self protected", async () => {
    const { db } = await freshDb();
    const wang = await createParticipant(db, user, " 小王 ", [wx("王大锤"), wx(" 王大锤 ")]);
    expect(wang).toMatchObject({ name: "小王", isSelf: false });
    expect(wang.identities.map((i) => [i.kind, i.value])).toEqual([["wechat", "王大锤"]]);
    await expect(createParticipant(db, user, "小赵", [wx("")])).rejects.toThrow(expect.objectContaining({ code: "identity_empty" }));
    expect((await listParticipants(db, user)).map((p) => p.name)).not.toContain("小赵");
    await expect(createParticipant(db, user, "小王")).rejects.toThrow(SplitError);
    const li = await createParticipant(db, user, "小李");
    await expect(renameParticipant(db, user, li.id, "小王")).rejects.toThrow(expect.objectContaining({ code: "participant_name_taken" }));
    expect((await renameParticipant(db, user, li.id, "李四")).name).toBe("李四");
    await expect(archiveParticipant(db, user, await selfId(db))).rejects.toThrow(expect.objectContaining({ code: "participant_self_archive" }));
    await expect(renameParticipant(db, user, await selfId(db), "me")).rejects.toThrow();
    await archiveParticipant(db, user, li.id);
    expect((await listParticipants(db, user)).map((p) => p.name)).toEqual(["我", "小王"]);
    expect(await listParticipants(db, user, { includeArchived: true })).toHaveLength(3);
  });

  it("orders by recent use after self", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const b = await createParticipant(db, user, "B");
    const t1 = await addTx(db, { amountMinor: -1000, occurredAt: "2026-09-01T10:00:00+08:00" });
    const t2 = await addTx(db, { amountMinor: -1000, occurredAt: "2026-09-05T10:00:00+08:00" });
    await toggleParticipant(db, user, t1, a.id);
    await toggleParticipant(db, user, t2, b.id);
    expect((await listParticipants(db, user)).map((p) => p.name)).toEqual(["我", "B", "A"]);
  });
});

describe("setSplit / toggle", () => {
  it("equal split gives the remainder to me: ¥100.00 / 3 → me 33.34", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const b = await createParticipant(db, user, "B");
    const t = await addTx(db, { amountMinor: -10000 });
    const s = (await setSplit(db, user, t, { participantIds: [a.id, b.id], mode: "equal" }))!;
    expect(s.myShareMinor).toBe(3334);
    expect(s.rows.map((r) => [r.name, r.owedMinor, r.paidMinor])).toEqual([
      ["我", 3334, 10000],
      ["A", 3333, 0],
      ["B", 3333, 0],
    ]);
    expect(s.mode).toBe("equal");
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(3333);
    const tx = (await db.select().from(transactions).where(eq(transactions.id, t)).limit(1))[0]!;
    expect(tx.userEditedAt).not.toBeNull();
  });

  it("toggle on, add, off, off clears", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const b = await createParticipant(db, user, "B");
    const t = await addTx(db, { amountMinor: -9001 });
    expect((await toggleParticipant(db, user, t, a.id))!.rows.map((r) => r.owedMinor)).toEqual([4501, 4500]);
    const s2 = (await toggleParticipant(db, user, t, b.id))!;
    expect(s2.participantIds).toEqual([a.id, b.id]);
    expect(s2.rows.map((r) => r.owedMinor)).toEqual([3001, 3000, 3000]);
    expect((await toggleParticipant(db, user, t, a.id))!.participantIds).toEqual([b.id]);
    expect(await toggleParticipant(db, user, t, b.id)).toBeNull();
    expect(await getSplit(db, user, t)).toBeNull();
    await expect(toggleParticipant(db, user, t, await selfId(db))).rejects.toThrow(SplitError);
  });

  it("remembers participants per merchant without touching category_id", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const cat = await catId(db, "买菜");
    await db.insert(merchantRules).values({ userId: user.id, merchant: "盒马", categoryId: cat });
    const t = await addTx(db, { amountMinor: -5000, merchant: "盒马" });
    await toggleParticipant(db, user, t, a.id);
    const rule = (await db.select().from(merchantRules).where(eq(merchantRules.merchant, "盒马")).limit(1))[0]!;
    expect(rule).toMatchObject({ categoryId: cat, participantIds: [a.id] });
    await toggleParticipant(db, user, t, a.id);
    const cleared = (await db.select().from(merchantRules).where(eq(merchantRules.merchant, "盒马")).limit(1))[0]!;
    expect(cleared).toMatchObject({ categoryId: cat, participantIds: null });
  });

  it("full mode: they owe everything, my share 0", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const t = await addTx(db, { amountMinor: -2500 });
    const s = (await setSplit(db, user, t, { participantIds: [a.id], mode: "full" }))!;
    expect(s.mode).toBe("full");
    expect(s.myShareMinor).toBe(0);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(2500);
    // toggling another person keeps "full"
    const b = await createParticipant(db, user, "B");
    const s2 = (await toggleParticipant(db, user, t, b.id))!;
    expect(s2.mode).toBe("full");
    expect(s2.rows.map((r) => r.owedMinor)).toEqual([0, 1250, 1250]);
  });

  it("exact mode validates the sum; me gets the rest if unlisted", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const t = await addTx(db, { amountMinor: -10000 });
    const s = (await setSplit(db, user, t, { participantIds: [a.id], mode: "exact", exact: [{ participantId: a.id, owedMinor: 7000 }] }))!;
    expect(s.mode).toBe("exact");
    expect(s.myShareMinor).toBe(3000);
    await expect(setSplit(db, user, t, { participantIds: [a.id], mode: "exact", exact: [{ participantId: a.id, owedMinor: 10001 }] })).rejects.toThrow(expect.objectContaining({ code: "split_exact_over_total" }));
    await expect(setSplit(db, user, t, {
              participantIds: [a.id],
              mode: "exact",
              exact: [
                { participantId: a.id, owedMinor: 5000 },
                { participantId: await selfId(db), owedMinor: 4000 },
              ],
            })).rejects.toThrow(expect.objectContaining({ code: "split_exact_not_total" }));
    // failed attempts leave the previous split intact
    expect((await getSplit(db, user, t))!.myShareMinor).toBe(3000);
  });

  it("refuses income rows and friend payer on my own account; refunds split as magnitudes and reduce the balance", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const inc = await addTx(db, { amountMinor: 5000 });
    await expect(toggleParticipant(db, user, inc, a.id)).rejects.toThrow(expect.objectContaining({ code: "split_kind_not_splittable" }));
    const t = await addTx(db, { amountMinor: -6000 });
    await expect(setSplit(db, user, t, { participantIds: [a.id], mode: "equal", payerId: a.id })).rejects.toThrow(expect.objectContaining({ code: "split_payer_must_be_self" }));
    await toggleParticipant(db, user, t, a.id);
    const refund = await addTx(db, { amountMinor: 2000, kind: "refund" });
    const r = (await toggleParticipant(db, user, refund, a.id))!;
    expect(r.rows.map((x) => x.owedMinor)).toEqual([1000, 1000]);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(3000 - 1000);
  });

  it("bulk toggle turns a participant on and off, skipping unsplittable rows", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const t1 = await addTx(db, { amountMinor: -1000 });
    const t2 = await addTx(db, { amountMinor: -2000 });
    const inc = await addTx(db, { amountMinor: 300 });
    const on = await bulkToggle(db, user, [t1, t2, inc, 9999], a.id, true);
    expect(on.updated).toEqual([t1, t2]);
    expect(on.skipped.map((s) => s.transactionId)).toEqual([inc, 9999]);
    expect((await bulkToggle(db, user, [t1], a.id, true)).unchanged).toEqual([t1]);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(1500);
    expect((await bulkToggle(db, user, [t1, t2], a.id, false)).updated).toEqual([t1, t2]);
    expect(await getSplit(db, user, t1)).toBeNull();
  });
});

describe("balances", () => {
  it("friend-paid expense makes the balance negative (I owe)", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友");
    const e = await createFriendPaidExpense(db, user, {
      payerId: a.id,
      totalMinor: 8000,
      currency: "CNY",
      occurredAt: "2026-09-12",
      description: "电费",
    });
    expect(e.myShareMinor).toBe(4000);
    expect(e.split!.payerId).toBe(a.id);
    const tx = (await db.select().from(transactions).where(eq(transactions.id, e.transactionId)).limit(1))[0]!;
    expect(tx).toMatchObject({ accountId: null, source: "manual", kind: "expense", amountMinor: -8000 });
    expect(tx.dedupKey).toMatch(/^manual:/);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(-4000);
  });

  it("friend paid entirely for me: empty participants, I owe the total", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友");
    const e = await createFriendPaidExpense(db, user, {
      payerId: a.id,
      totalMinor: 3000,
      currency: "USD",
      occurredAt: "2026-09-12",
      description: "代买",
      participantIds: [],
    });
    expect(e.myShareMinor).toBe(3000);
    expect((await bal(db, a.id, "USD"))!.owedToMeMinor).toBe(-3000);
  });

  it("keeps currencies separate; FX settlement zeroes USD and leaves CNY", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -10000, currency: "USD" }), a.id);
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -4000 }), a.id);
    expect((await bal(db, a.id, "USD"))!.owedToMeMinor).toBe(5000);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(2000);
    const s = await settleAll(db, user, a.id, "USD", { settledOn: "2026-09-20", originalAmountMinor: 36000, originalCurrency: "CNY" });
    expect(s).toMatchObject({ amountMinor: 5000, currency: "USD", originalAmountMinor: 36000, originalCurrency: "CNY" });
    expect(await bal(db, a.id, "USD")).toMatchObject({ owedToMeMinor: 0, lastSettledOn: "2026-09-20", openItemCount: 0 });
    expect(await bal(db, a.id, "CNY")).toMatchObject({ owedToMeMinor: 2000, lastSettledOn: null, openItemCount: 1 });
    await expect(settleAll(db, user, a.id, "USD", { settledOn: "2026-09-21" })).rejects.toThrow(expect.objectContaining({ code: "settlement_already_even" }));
  });

  it("ignores closed and duplicate-linked rows", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const t1 = await addTx(db, { amountMinor: -1000 });
    const t2 = await addTx(db, { amountMinor: -2000 });
    const t3 = await addTx(db, { amountMinor: -4000 });
    for (const t of [t1, t2, t3]) await toggleParticipant(db, user, t, a.id);
    await db.update(transactions).set({ status: "closed" }).where(eq(transactions.id, t2));
    await db.update(transactions).set({ duplicateOfId: t1 }).where(eq(transactions.id, t3));
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(500);
  });

  it("hides archived participants only when settled", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -1000 }), a.id);
    await archiveParticipant(db, user, a.id);
    expect(await bal(db, a.id, "CNY")).toMatchObject({ owedToMeMinor: 500, archived: true });
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 500, currency: "CNY", settledOn: "2026-09-11" });
    expect(await bal(db, a.id, "CNY")).toBeUndefined();
  });
});

describe("settlements", () => {
  it("records, lists, deletes; validates", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -1000 }), a.id);
    const s = await recordSettlement(db, user, { participantId: a.id, amountMinor: 300, currency: "cny", settledOn: "2026-09-11", note: " 部分 " });
    expect(s).toMatchObject({ currency: "CNY", note: "部分", participantName: "A" });
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(200);
    expect(await listSettlements(db, user, a.id)).toHaveLength(1);
    await expect(recordSettlement(db, user, { participantId: a.id, amountMinor: 0, currency: "CNY", settledOn: "2026-09-11" })).rejects.toThrow();
    await expect(recordSettlement(db, user, { participantId: await selfId(db), amountMinor: 1, currency: "CNY", settledOn: "2026-09-11" })).rejects.toThrow();
    await expect(recordSettlement(db, user, { participantId: a.id, amountMinor: 1, currency: "CNY", settledOn: "2026-09-11", originalAmountMinor: 5 })).rejects.toThrow(expect.objectContaining({ code: "settlement_original_incomplete" }));
    await deleteSettlement(db, user, s.id);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(500);
    await expect(deleteSettlement(db, user, s.id)).rejects.toThrow(expect.objectContaining({ code: "settlement_not_found" }));
  });

  it("settleAll on a negative balance records a negative settlement (I pay)", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    await createFriendPaidExpense(db, user, { payerId: a.id, totalMinor: 1000, currency: "CNY", occurredAt: "2026-09-01", description: "x" });
    expect((await settleAll(db, user, a.id, "CNY", { settledOn: "2026-09-02" })).amountMinor).toBe(-500);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(0);
  });
});

describe("candidates and markAsSettlement", () => {
  async function withTransfers() {
    const f = await freshDb();
    const a = await createParticipant(f.db, user, "室友", [wx("A-Wang")]);
    await toggleParticipant(f.db, user, await addTx(f.db, { amountMinor: -10000 }), a.id);
    const known = await addTx(f.db, { amountMinor: 5000, counterpartyRaw: "A-Wang", sourceCategory: "转账", occurredAt: "2026-09-15T09:00:00+08:00" });
    const fuzzy = await addTx(f.db, { amountMinor: 700, counterpartyRaw: "A-Wang🌙", sourceCategory: "微信红包", occurredAt: "2026-09-14T09:00:00+08:00" });
    const stranger = await addTx(f.db, { amountMinor: 1200, counterpartyRaw: "路人", sourceCategory: "二维码收款", occurredAt: "2026-09-13T09:00:00+08:00" });
    const oldStranger = await addTx(f.db, { amountMinor: 1200, counterpartyRaw: "路人", sourceCategory: "转账", occurredAt: "2026-05-01T09:00:00+08:00" });
    const salary = await addTx(f.db, { amountMinor: 900000, counterpartyRaw: "公司", sourceCategory: "其他", occurredAt: "2026-09-10T09:00:00+08:00" });
    return { ...f, a, known, fuzzy, stranger, oldStranger, salary };
  }

  it("matches aliases (exact and contains) and lists recent unknown senders", async () => {
    const { db, a, known, fuzzy, stranger } = await withTransfers();
    const c = await settlementCandidates(db, user, { today: "2026-09-29" });
    expect(c.map((x) => [x.transactionId, x.match, x.suggestedParticipantId])).toEqual([
      [known, "alias_exact", a.id],
      [fuzzy, "alias_contains", a.id],
      [stranger, "none", null],
    ]);
    expect(c[0]).toMatchObject({ suggestedAmountMinor: 5000, suggestedCurrency: "CNY", balances: [{ currency: "CNY", owedToMeMinor: 5000 }] });
  });

  it("suggests the other currency when the participant only owes there", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友", [wx("Wang")]);
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -10000, currency: "USD" }), a.id);
    await addTx(db, { amountMinor: 36000, counterpartyRaw: "Wang", sourceCategory: "转账" });
    const [c] = await settlementCandidates(db, user, { today: "2026-09-29" });
    expect(c).toMatchObject({ amountMinor: 36000, currency: "CNY", suggestedAmountMinor: null, suggestedCurrency: "USD" });
    const s = await markAsSettlement(db, user, c!.transactionId, { participantId: a.id, amountMinor: 5000, currency: "USD" });
    expect(s).toMatchObject({ amountMinor: 5000, currency: "USD", originalAmountMinor: 36000, originalCurrency: "CNY" });
    expect((await bal(db, a.id, "USD"))!.owedToMeMinor).toBe(0);
  });

  it("markAsSettlement flips kind to transfer, links, learns the identity; delete restores income", async () => {
    const { db, a, stranger } = await withTransfers();
    const s = await markAsSettlement(db, user, stranger, { participantId: a.id });
    expect(s).toMatchObject({ amountMinor: 1200, currency: "CNY", transactionId: stranger, settledOn: "2026-09-13" });
    const tx = (await db.select().from(transactions).where(eq(transactions.id, stranger)).limit(1))[0]!;
    expect(tx.kind).toBe("transfer");
    expect(tx.userEditedAt).not.toBeNull();
    expect((await listIdentities(db, user, a.id)).map((i) => [i.kind, i.value, i.source])).toEqual([
      ["wechat", "A-Wang", "manual"],
      ["wechat", "路人", "claimed"],
    ]);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(5000 - 1200);
    await expect(markAsSettlement(db, user, stranger, { participantId: a.id })).rejects.toThrow(expect.objectContaining({ code: "settlement_already_linked" }));
    expect((await settlementCandidates(db, user, { today: "2026-09-29" })).some((c) => c.transactionId === stranger)).toBe(false);
    expect((await deleteSettlement(db, user, s.id)).restoredTransactionId).toBe(stranger);
    expect((await db.select().from(transactions).where(eq(transactions.id, stranger)).limit(1))[0]!.kind).toBe("income");
  });

  it("lists Zelle from BoA CSV and Plaid by alias, case-insensitively, and outgoing Zelle to a participant", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "Alex", [{ kind: "zelle_name", value: "alex tester" }]);
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -10000, currency: "USD" }), a.id);
    const usd = { currency: "USD", occurredAt: "2026-09-15T12:00:00-05:00" };
    const boaIn = await addTx(db, { ...usd, amountMinor: 2500, source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: "ALEX TESTER" });
    const boaOut = await addTx(db, { ...usd, amountMinor: -1200, source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: "ALEX TESTER" });
    const plaidIn = await addTx(db, {
      ...usd,
      amountMinor: 700,
      source: "plaid",
      sourceCategory: "TRANSFER_IN/TRANSFER_IN_TRANSFER_IN_FROM_APPS",
      counterpartyRaw: "Zelle payment from ALEX TESTER Conf# x1",
      descriptionRaw: "Zelle payment from ALEX TESTER Conf# x1",
    });
    await addTx(db, { ...usd, amountMinor: -900, source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: "SOMEONE ELSE" });
    await addTx(db, { ...usd, amountMinor: 900, source: "boa_csv", sourceCategory: "Purchase", counterpartyRaw: "ALEX TESTER" });
    const c = await settlementCandidates(db, user, { today: "2026-09-29" });
    const view = c.map((x) => [x.transactionId, x.match, x.suggestedParticipantId, x.amountMinor, x.counterparty] as const);
    expect(view.sort((x, y) => x[0] - y[0])).toEqual([
      [boaIn, "alias_exact", a.id, 2500, "ALEX TESTER"],
      [boaOut, "alias_exact", a.id, -1200, "ALEX TESTER"],
      [plaidIn, "alias_exact", a.id, 700, "ALEX TESTER"],
    ]);
    expect((await markAsSettlement(db, user, boaOut, { participantId: a.id })).amountMinor).toBe(-1200);
    expect((await bal(db, a.id, "USD"))!.owedToMeMinor).toBe(5000 + 1200);
  });

  it("outgoing transfer gives a negative settlement", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    await createFriendPaidExpense(db, user, { payerId: a.id, totalMinor: 2000, currency: "CNY", occurredAt: "2026-09-01", description: "x" });
    const out = await addTx(db, { amountMinor: -1000, counterpartyRaw: "A", sourceCategory: "转账" });
    expect((await markAsSettlement(db, user, out, { participantId: a.id })).amountMinor).toBe(-1000);
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(0);
  });
});

describe("statement", () => {
  it("window starts after the last zero point", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -2000, merchant: "旧账", occurredAt: "2026-08-01T10:00:00+08:00" }), a.id);
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 1000, currency: "CNY", settledOn: "2026-08-05" });
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -10000, merchant: "盒马", occurredAt: "2026-09-03T10:00:00+08:00" }), a.id);
    await createFriendPaidExpense(db, user, { payerId: a.id, totalMinor: 8000, currency: "CNY", occurredAt: "2026-09-10", description: "电费" });
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 500, currency: "CNY", settledOn: "2026-09-12" });

    const st = await statementText(db, user, a.id, "CNY", { locale: "zh-CN", today: "2026-09-29" });
    expect(st.since).toBe("2026-09-03");
    expect(st.items.map((i) => i.merchant)).toEqual(["盒马", "电费"]);
    expect(st.balanceMinor).toBe(5000 - 4000 - 500);
    // Legacy amount-only settlements cover the oldest items first: ¥10 pays 旧账, ¥5 part of 盒马.
    expect(st.openItems.map((i) => [i.merchant, i.status, i.remainingMinor])).toEqual([
      ["盒马", "partial", 4500],
      ["电费", "open", -4000],
    ]);
    expect(st.recentSince).toBe("2026-07-31");
    expect(st.text).toBe(
      [
        "和室友的AA账单（CNY）",
        "",
        "未结清：",
        "09-03 盒马 共¥100.00，你的份额 ¥50.00（已结一部分，还剩 ¥45.00）",
        "09-10 电费 共¥80.00，你付的，你的份额 ¥40.00",
        "",
        "最近结算：",
        "09-12 你转我 ¥5.00",
        "08-05 你转我 ¥10.00",
        "",
        "合计：你欠我 ¥5.00",
      ].join("\n"),
    );
    expect(st.text).not.toMatch(/—/);

    const all = await statementText(db, user, a.id, "CNY", { since: "2026-08-03", locale: "zh-CN" });
    expect(all.openingMinor).toBe(1000);
    expect(all.settlements.map((s) => s.date)).toEqual(["2026-08-05", "2026-09-12"]);

    await settleAll(db, user, a.id, "CNY", { settledOn: "2026-09-20" });
    const done = await statementText(db, user, a.id, "CNY", { locale: "zh-CN", today: "2026-09-29" });
    expect(done.items).toEqual([]);
    expect(done.openItems).toEqual([]);
    // Settle-all names every open item, with the part of each it paid.
    expect(done.recentSettlements[0]!.items.map((i) => [i.merchant, i.paidMinor, i.status])).toEqual([
      ["盒马", 4500, "covered"],
      ["电费", -4000, "covered"],
    ]);
    expect(done.text).toContain("没有未结清的账目。");
    expect(done.text).toContain("09-20 你转我 ¥5.00\n  包含：\n  - 09-03 盒马 ¥45.00\n  - 09-10 电费 ¥40.00");
    expect(done.text).toContain("合计：已结清");
    expect((await statementText(db, user, a.id, "CNY")).text).toContain("Total: all square");
  });

  it("English text by default", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "Roommate");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -10000, merchant: "Costco", occurredAt: "2026-09-03T10:00:00+08:00" }), a.id);
    await createFriendPaidExpense(db, user, { payerId: a.id, totalMinor: 8000, currency: "CNY", occurredAt: "2026-09-10", description: "Power" });
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 500, currency: "CNY", settledOn: "2026-09-12" });
    expect((await statementText(db, user, a.id, "CNY", { today: "2026-09-29" })).text).toBe(
      [
        "Shared expenses with Roommate (CNY)",
        "",
        "Not settled yet:",
        "9/3 Costco ¥100.00, your share ¥50.00 (partly settled, ¥45.00 left)",
        "9/10 Power ¥80.00, you paid, your share ¥40.00",
        "",
        "Settled recently:",
        "9/12 you sent me ¥5.00",
        "",
        "Total: you owe me ¥5.00",
      ].join("\n"),
    );
    // Old settlements drop out of the recent list.
    expect((await statementText(db, user, a.id, "CNY", { today: "2026-12-31" })).recentSettlements).toEqual([]);
  });

  it("My payment details: the methods for the currency, only when something is due and the option is on", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "Roommate");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -5100, currency: "USD", merchant: "Costco", occurredAt: "2026-09-03T10:00:00+08:00" }), a.id);
    const none = { email: null, phone: null, username: null, text: null };
    const base = { label: null, ...none, qr: null, original: null, display: "clean" as const, currencies: ["USD"], showOnStatement: true };
    await setPaymentMethods(db, user, [
      { ...base, kind: "zelle", label: "Zelle (Chase)", email: "alex@example.com", phone: "+12025550143" },
      { ...base, kind: "wechat", text: "alex-demo", currencies: ["CNY"] },
      { ...base, kind: "venmo", username: "@alex-demo", showOnStatement: false },
      { ...base, kind: "paypal", username: "alexdemo" },
      { ...base, kind: "zelle", label: "Zelle QR", qr: "https://example.com/qr/alex-demo" },
    ]);
    const st = await statementText(db, user, a.id, "USD", { today: "2026-09-29" });
    expect(st.payment.map((m) => [m.kind, m.link])).toEqual([
      ["zelle", null],
      ["paypal", "https://paypal.me/alexdemo/25.50USD"],
      ["zelle", null],
    ]);
    expect(st.text.split("\n").slice(-6)).toEqual([
      "Total: you owe me $25.50",
      "",
      "My payment details:",
      "Zelle (Chase): alex@example.com  202-555-0143",
      "PayPal: alexdemo  https://paypal.me/alexdemo/25.50USD",
      "Zelle QR: QR code in the PDF",
    ]);
    expect((await statementText(db, user, a.id, "USD", { locale: "zh-CN" })).text).toContain("\n我的收款信息：\nZelle (Chase): alex@example.com  202-555-0143");
    // Off by option, and nothing to pay (all settled) shows no block either.
    const off = await statementText(db, user, a.id, "USD", { show: ["shared", "notes"] });
    expect(off.payment).toEqual([]);
    expect(off.text).not.toContain("My payment details");
    await settleAll(db, user, a.id, "USD", { settledOn: "2026-09-20" });
    expect((await statementText(db, user, a.id, "USD")).payment).toEqual([]);
  });

  it("says 我欠你 when negative", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    await createFriendPaidExpense(db, user, { payerId: a.id, totalMinor: 3001, currency: "USD", occurredAt: "2026-09-01", description: "Costco" });
    expect((await statementText(db, user, a.id, "USD", { locale: "zh-CN" })).text).toMatch(/合计：我欠你 \$15\.01$/);
    expect((await statementText(db, user, a.id, "USD")).text).toMatch(/Total: I owe you \$15\.01$/);
  });
});

describe("opening balance", () => {
  it("they owe me X gives a -X settlement, balance X, not counted as settled", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友");
    const s = await recordOpeningBalance(db, user, { participantId: a.id, direction: "they_owe_me", amountMinor: 18250, currency: "usd", date: "2026-09-01" });
    expect(s).toMatchObject({ amountMinor: -18250, currency: "USD", note: null, opening: true, settledOn: "2026-09-01" });
    expect(await bal(db, a.id, "USD")).toMatchObject({ owedToMeMinor: 18250, lastSettledOn: null, openItemCount: 0 });
    expect((await listSettlements(db, user, a.id))[0]).toMatchObject({ opening: true });

    const mine = await recordOpeningBalance(db, user, { participantId: a.id, direction: "i_owe_them", amountMinor: 4000, currency: "CNY", date: "2026-09-01", note: "八月房租差额" });
    expect(mine).toMatchObject({ amountMinor: 4000, note: "八月房租差额", opening: true });
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(-4000);

    await expect(recordOpeningBalance(db, user, { participantId: a.id, direction: "they_owe_me", amountMinor: 0, currency: "USD", date: "2026-09-01" })).rejects.toThrow();
    await expect(recordOpeningBalance(db, user, { participantId: await selfId(db), direction: "they_owe_me", amountMinor: 1, currency: "USD", date: "2026-09-01" })).rejects.toThrow();
  });

  it("statement shows the opening line at the start of the window, not under 已结算", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -10000, merchant: "盒马", occurredAt: "2026-09-01T10:00:00+08:00" }), a.id);
    await recordOpeningBalance(db, user, { participantId: a.id, direction: "they_owe_me", amountMinor: 20000, currency: "CNY", date: "2026-09-01" });
    await recordSettlement(db, user, { participantId: a.id, amountMinor: 5000, currency: "CNY", settledOn: "2026-09-05" });

    const st = await statementText(db, user, a.id, "CNY", { locale: "zh-CN", today: "2026-09-29" });
    expect(st.openingBalanceMinor).toBe(20000);
    expect(st.settlements).toHaveLength(1);
    expect(st.balanceMinor).toBe(20000 + 5000 - 5000);
    // The opening balance is the oldest entry, so the ¥50 goes to it first.
    expect(st.openOpeningMinor).toBe(15000);
    expect(st.text).toBe(
      [
        "和室友的AA账单（CNY）",
        "期初余额：你欠我 ¥150.00",
        "",
        "未结清：",
        "09-01 盒马 共¥100.00，你的份额 ¥50.00",
        "",
        "最近结算：",
        "09-05 你转我 ¥50.00",
        "",
        "合计：你欠我 ¥200.00",
      ].join("\n"),
    );

    const later = await statementText(db, user, a.id, "CNY", { since: "2026-09-02", locale: "zh-CN" });
    expect(later.openingBalanceMinor).toBe(0);
    expect(later.openingMinor).toBe(25000);
  });

  it("clearBefore settles only what is dated before the day and starts the window there", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -2000, merchant: "旧账", occurredAt: "2026-07-01T10:00:00+08:00" }), a.id);
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -6000, merchant: "当天", occurredAt: "2026-09-01T09:00:00+08:00" }), a.id);
    const s = await clearBefore(db, user, a.id, "CNY", "2026-09-01");
    expect(s).toMatchObject({ amountMinor: 1000, settledOn: "2026-08-31", opening: false });
    expect(await bal(db, a.id, "CNY")).toMatchObject({ owedToMeMinor: 3000, lastSettledOn: "2026-08-31", openItemCount: 1 });
    const st = await statementText(db, user, a.id, "CNY");
    expect(st.since).toBe("2026-09-01");
    expect(st.items.map((i) => i.merchant)).toEqual(["当天"]);
    await expect(clearBefore(db, user, a.id, "CNY", "2026-09-01")).rejects.toThrow(expect.objectContaining({ code: "clear_before_already_even" }));
  });
});

describe("unsplitSuggestions", () => {
  it("lists merchant-rule rows and large shared-category rows", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友");
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -3000, merchant: "盒马", occurredAt: "2026-09-01T10:00:00+08:00" }), a.id);
    const again = await addTx(db, { amountMinor: -1500, merchant: "盒马", occurredAt: "2026-09-20T10:00:00+08:00" });
    const bigFood = await addTx(db, { amountMinor: -25000, merchant: "火锅", categoryId: await catId(db, "餐饮"), occurredAt: "2026-09-18T10:00:00+08:00" });
    await addTx(db, { amountMinor: -5000, merchant: "小吃", categoryId: await catId(db, "餐饮"), occurredAt: "2026-09-18T10:00:00+08:00" });
    await addTx(db, { amountMinor: -50000, merchant: "衣服", categoryId: await catId(db, "购物"), occurredAt: "2026-09-18T10:00:00+08:00" });
    await addTx(db, { amountMinor: -30000, merchant: "老房租", categoryId: await catId(db, "居住"), occurredAt: "2026-06-01T10:00:00+08:00" });
    const s = await unsplitSuggestions(db, user, { today: "2026-09-29" });
    expect(s.map((x) => [x.transactionId, x.reason, x.suggestedParticipantIds])).toEqual([
      [again, "merchant_rule", [a.id]],
      [bigFood, "category", [a.id]],
    ]);
    expect((await unsplitSuggestions(db, user, { month: "2026-06" })).map((x) => x.merchant)).toEqual(["老房租"]);
  });
});

describe("friend-paid rows with third participants (star model)", () => {
  it("B paid ¥90 for me, A and B: only me and B are stored, I owe B ¥30, nothing for A", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const b = await createParticipant(db, user, "B");
    const e = await createFriendPaidExpense(db, user, {
      payerId: b.id,
      totalMinor: 9000,
      currency: "CNY",
      occurredAt: "2026-09-12",
      description: "晚饭",
      participantIds: [a.id, b.id],
    });
    expect(e.myShareMinor).toBe(3000);
    expect(e.split!.rows.map((r) => [r.name, r.owedMinor, r.paidMinor])).toEqual([
      ["我", 3000, 0],
      ["B", 6000, 9000],
    ]);
    expect((await bal(db, b.id, "CNY"))!.owedToMeMinor).toBe(-3000);
    expect(await bal(db, a.id, "CNY")).toBeUndefined();
  });

  it("remainder still goes to me and exact mode keeps my listed share", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const b = await createParticipant(db, user, "B");
    const t = await addTx(db, { amountMinor: -10000, accountId: null, source: "manual" });
    const s = (await setSplit(db, user, t, { participantIds: [a.id, b.id], mode: "equal", payerId: b.id }))!;
    expect(s.rows.map((r) => [r.participantId, r.owedMinor, r.paidMinor])).toEqual([
      [await selfId(db), 3334, 0],
      [b.id, 6666, 10000],
    ]);
    const x = (await setSplit(db, user, t, {
      participantIds: [a.id, b.id],
      mode: "exact",
      exact: [
        { participantId: a.id, owedMinor: 5000 },
        { participantId: b.id, owedMinor: 2000 },
      ],
      payerId: b.id,
    }))!;
    expect(x.rows.map((r) => [r.participantId, r.owedMinor, r.paidMinor])).toEqual([
      [await selfId(db), 3000, 0],
      [b.id, 7000, 10000],
    ]);
    expect((await bal(db, b.id, "CNY"))!.owedToMeMinor).toBe(-3000);
  });

  it("chips on a friend-paid row are refused: third participant and payer off", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const b = await createParticipant(db, user, "B");
    const e = await createFriendPaidExpense(db, user, { payerId: b.id, totalMinor: 9000, currency: "CNY", occurredAt: "2026-09-12", description: "x" });
    await expect(toggleParticipant(db, user, e.transactionId, a.id)).rejects.toThrow(expect.objectContaining({ code: "split_friend_paid_third_party" }));
    await expect(toggleParticipant(db, user, e.transactionId, b.id)).rejects.toThrow(SplitError);
    expect((await getSplit(db, user, e.transactionId))!.myShareMinor).toBe(4500);
    const bulk = await bulkToggle(db, user, [e.transactionId], a.id, true);
    expect(bulk.skipped.map((s) => s.code)).toEqual(["split_friend_paid_third_party"]);
    expect((await bulkToggle(db, user, [e.transactionId], b.id, false)).skipped).toHaveLength(1);
    expect((await getSplit(db, user, e.transactionId))!.rows).toHaveLength(2);
  });
});

describe("balances only count expense/refund rows", () => {
  it("a split row whose kind was forced to transfer leaves the balance", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const t = await addTx(db, { amountMinor: -1000 });
    await toggleParticipant(db, user, t, a.id);
    const t2 = await addTx(db, { amountMinor: -3000 });
    await toggleParticipant(db, user, t2, a.id);
    await db.update(transactions).set({ kind: "transfer" }).where(eq(transactions.id, t2));
    expect((await bal(db, a.id, "CNY"))!.owedToMeMinor).toBe(500);
  });
});

describe("settlement links keep the prior kind", () => {
  it("deleting a settlement on a row that was a transfer leaves it a transfer", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const t = await addTx(db, { amountMinor: 2000, kind: "transfer", counterpartyRaw: "A", sourceCategory: "转账" });
    const s = await markAsSettlement(db, user, t, { participantId: a.id });
    expect((await deleteSettlement(db, user, s.id)).restoredTransactionId).toBeNull();
    expect((await db.select().from(transactions).where(eq(transactions.id, t)).limit(1))[0]!.kind).toBe("transfer");
  });

  it("recordSettlement with transactionId flips income to transfer, marks it edited, delete restores income", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const t = await addTx(db, { amountMinor: 2000, counterpartyRaw: "A", sourceCategory: "转账" });
    const s = await recordSettlement(db, user, { participantId: a.id, amountMinor: 2000, currency: "CNY", settledOn: "2026-09-10", transactionId: t });
    const row = (await db.select().from(transactions).where(eq(transactions.id, t)).limit(1))[0]!;
    expect(row.kind).toBe("transfer");
    expect(row.userEditedAt).not.toBeNull();
    expect((await deleteSettlement(db, user, s.id)).restoredTransactionId).toBe(t);
    expect((await db.select().from(transactions).where(eq(transactions.id, t)).limit(1))[0]!.kind).toBe("income");
  });

  it("settleAll with transactionId links and flips an expense", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    await createFriendPaidExpense(db, user, { payerId: a.id, totalMinor: 2000, currency: "CNY", occurredAt: "2026-09-01", description: "x" });
    const out = await addTx(db, { amountMinor: -1000, counterpartyRaw: "A", sourceCategory: "转账" });
    await settleAll(db, user, a.id, "CNY", { settledOn: "2026-09-10", transactionId: out });
    const row = (await db.select().from(transactions).where(eq(transactions.id, out)).limit(1))[0]!;
    expect(row).toMatchObject({ kind: "transfer" });
    expect(row.userEditedAt).not.toBeNull();
  });

  it("legacy linked settlement without prior kind leaves the row alone on delete", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const t = await addTx(db, { amountMinor: 2000, kind: "transfer" });
    const s = (await db
      .insert(settlements)
      .values({ userId: user.id, participantId: a.id, amountMinor: 2000, currency: "CNY", settledOn: "2026-09-10", transactionId: t })
      .returning())[0]!;
    expect((await deleteSettlement(db, user, s.id)).restoredTransactionId).toBeNull();
    expect((await db.select().from(transactions).where(eq(transactions.id, t)).limit(1))[0]!.kind).toBe("transfer");
  });

  it("markAsSettlement refuses closed, duplicate and refund rows", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const closed = await addTx(db, { amountMinor: 2000, status: "closed" });
    const orig = await addTx(db, { amountMinor: 2000 });
    const dup = await addTx(db, { amountMinor: 2000, duplicateOfId: orig });
    for (const id of [closed, dup]) await expect(markAsSettlement(db, user, id, { participantId: a.id })).rejects.toThrow(SplitError);
  });
});

describe("opening balance column", () => {
  it("uses settlements.kind, not the note", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const o = await recordOpeningBalance(db, user, { participantId: a.id, direction: "they_owe_me", amountMinor: 1000, currency: "CNY", date: "2026-09-01" });
    expect(o).toMatchObject({ kind: "opening", opening: true });
    expect((await db.select().from(settlements).where(eq(settlements.id, o.id)).limit(1))[0]!.kind).toBe("opening");
    const p = await recordSettlement(db, user, { participantId: a.id, amountMinor: 400, currency: "CNY", settledOn: "2026-09-05", note: "期初余额的一部分" });
    expect(p).toMatchObject({ kind: "payment", opening: false });
    expect(await bal(db, a.id, "CNY")).toMatchObject({ owedToMeMinor: 600, lastSettledOn: "2026-09-05" });
    expect((await listSettlements(db, user, a.id)).map((s) => s.kind)).toEqual(["payment", "opening"]);
  });
});

describe("toggle result flags", () => {
  it("chip on an exact row re-splits equally and says so", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "A");
    const b = await createParticipant(db, user, "B");
    const t = await addTx(db, { amountMinor: -10000 });
    await setSplit(db, user, t, { participantIds: [a.id], mode: "exact", exact: [{ participantId: a.id, owedMinor: 7000 }] });
    const r = await toggleParticipantResult(db, user, t, b.id);
    expect(r.resetExact).toBe(true);
    expect(r.split!.mode).toBe("equal");
    expect((await toggleParticipantResult(db, user, t, b.id)).resetExact).toBe(false);
  });
});

describe("candidates: double credit and FX", () => {
  it("flags a candidate when an unlinked settlement of the same amount exists within 3 days", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友", [wx("Wang")]);
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -10000 }), a.id);
    const manual = await recordSettlement(db, user, { participantId: a.id, amountMinor: 5000, currency: "CNY", settledOn: "2026-09-12" });
    await addTx(db, { amountMinor: 5000, counterpartyRaw: "Wang", sourceCategory: "转账", occurredAt: "2026-09-14T10:00:00+08:00" });
    await addTx(db, { amountMinor: 5000, counterpartyRaw: "Wang", sourceCategory: "转账", occurredAt: "2026-09-20T10:00:00+08:00" });
    const c = await settlementCandidates(db, user, { today: "2026-09-29" });
    expect(c.map((x) => x.possiblyCovered?.settlementId ?? null)).toEqual([null, manual.id]);
    expect(c[1]!.possiblyCovered).toMatchObject({ amountMinor: 5000, currency: "CNY", settledOn: "2026-09-12" });
  });

  it("other-currency debt: proportional amount from the last known rate, empty without one", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友", [wx("Wang")]);
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -40000, currency: "USD" }), a.id);
    await addTx(db, { amountMinor: 36000, counterpartyRaw: "Wang", sourceCategory: "转账", occurredAt: "2026-09-15T10:00:00+08:00" });
    let [c] = await settlementCandidates(db, user, { today: "2026-09-29" });
    expect(c).toMatchObject({ suggestedCurrency: "USD", suggestedAmountMinor: null });
    await recordSettlement(db, user, {
      participantId: a.id,
      amountMinor: 1000,
      currency: "USD",
      originalAmountMinor: 7200,
      originalCurrency: "CNY",
      settledOn: "2026-08-01",
    });
    [c] = await settlementCandidates(db, user, { today: "2026-09-29" });
    expect(c).toMatchObject({ suggestedCurrency: "USD", suggestedAmountMinor: 5000 });
  });
});

describe("split dates follow the user's time zone", () => {
  // 09:00 in Beijing on Oct 1 is the evening of Sep 30 in America/Chicago, the default zone.
  const BEIJING_MORNING = "2026-10-01T09:00:00+08:00";
  const inZone = (occurredAt: string) => ({ occurredAt, occurredOn: occurredOnFor(occurredAt, "wechat", DEFAULT_TIME_ZONE) });

  it("a +08:00 row is dated by the user's day on the statement, as a settlement and in a month's suggestions", async () => {
    const { db } = await freshDb();
    const a = await createParticipant(db, user, "室友", [wx("A-Wang")]);
    const dinner = await addTx(db, { amountMinor: -10000, ...inZone(BEIJING_MORNING) });
    await toggleParticipant(db, user, dinner, a.id);
    const st = await statementText(db, user, a.id, "CNY", { scope: "all", today: "2026-10-02" });
    expect(st.entries.map((e) => [e.transactionId, e.date])).toEqual([[dinner, "2026-09-30"]]);

    const transfer = await addTx(db, { amountMinor: 5000, counterpartyRaw: "A-Wang", sourceCategory: "转账", ...inZone(BEIJING_MORNING) });
    expect((await markAsSettlement(db, user, transfer, { participantId: a.id })).settledOn).toBe("2026-09-30");

    const rent = await addTx(db, { amountMinor: -48000, categoryId: await catId(db, "居住"), ...inZone(BEIJING_MORNING) });
    expect((await unsplitSuggestions(db, user, { month: "2026-09" })).map((s) => s.transactionId)).toContain(rent);
    expect((await unsplitSuggestions(db, user, { month: "2026-10" })).map((s) => s.transactionId)).not.toContain(rent);
  });

  it("an unknown sender stays a candidate for 90 days counted in the user's days", async () => {
    const { db } = await freshDb();
    // Jul 2 in Chicago: 90 days before Sep 30.
    const stranger = await addTx(db, { amountMinor: 1200, counterpartyRaw: "路人", sourceCategory: "转账", ...inZone("2026-07-03T09:00:00+08:00") });
    expect((await settlementCandidates(db, user, { today: "2026-09-30" })).map((c) => c.transactionId)).toEqual([stranger]);
    expect(await settlementCandidates(db, user, { today: "2026-10-01" })).toEqual([]);
  });
});
