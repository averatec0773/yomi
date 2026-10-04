import { merchantRules, transactions } from "@yomi/db";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { LedgerError } from "./errors";
import { recategorizeUnedited } from "./recategorize";
import { addParticipant, addSplit, addTx, catId, freshDb, selfId, user } from "./test-helpers";
import { listMonths, listTransactions, monthTotalsForList } from "./transactions";
import {
  archiveCategory,
  bulkUpdate,
  createCategory,
  listCategories,
  renameCategory,
  setCategory,
  updateTransaction,
} from "./update";

describe("listTransactions", () => {
  async function setup() {
    const db = await freshDb();
    const food = await catId(db, "餐饮");
    const other = await catId(db, "其他");
    const roomie = await addParticipant(db, "室友");
    const a = await addTx(db, { amountMinor: -3500, merchant: "面馆", counterpartyRaw: "某面馆", categoryId: food, occurredAt: "2026-09-03T12:00:00+08:00" });
    const b = await addTx(db, { amountMinor: -12000, merchant: "Kroger", counterpartyRaw: "KROGER 00123", currency: "USD", note: "weekly Groceries", categoryId: other, occurredAt: "2026-09-05T09:00:00+08:00" });
    const c = await addTx(db, { amountMinor: 50000, merchant: "公司", kind: "income", occurredAt: "2026-08-30T09:00:00+08:00" });
    const d = await addTx(db, { amountMinor: -2000, merchant: "转账", kind: "transfer", occurredAt: "2026-09-07T09:00:00+08:00" });
    await addSplit(db, b, await selfId(db), 6000, 12000, "USD");
    await addSplit(db, b, roomie, 6000, 0, "USD");
    await db.insert(merchantRules).values({ userId: user.id, merchant: "面馆", participantIds: [roomie] });
    return { db, food, other, roomie, a, b, c, d };
  }

  it("orders newest first and filters by month, kind, category and participant", async () => {
    const { db, food, roomie, a, b, c, d } = await setup();
    expect((await listTransactions(db, user)).items.map((t) => t.id)).toEqual([d, b, a, c]);
    const sep = await listTransactions(db, user, { month: "2026-09" });
    expect(sep.items.map((t) => t.id)).toEqual([d, b, a]);
    expect(sep.total).toBe(3);
    expect((await listTransactions(db, user, { kind: "income" })).items.map((t) => t.id)).toEqual([c]);
    expect((await listTransactions(db, user, { categoryId: food })).items.map((t) => t.id)).toEqual([a]);
    expect((await listTransactions(db, user, { participantId: roomie })).items.map((t) => t.id)).toEqual([b]);
    expect(await listTransactions(db, user, { limit: 1, offset: 1 })).toMatchObject({ total: 4, items: [{ id: b }] });
    await expect(listTransactions(db, user, { month: "2026-13" })).rejects.toThrow(LedgerError);
  });

  it("uncategorized means no category or the fallback 其他, never transfers", async () => {
    const { db, b, c } = await setup();
    expect((await listTransactions(db, user, { uncategorized: true })).items.map((t) => t.id)).toEqual([b, c]);
  });

  it("searches merchant, counterparty, description and note case-insensitively, and amounts", async () => {
    const { db, a, b } = await setup();
    expect((await listTransactions(db, user, { q: "kroger" })).items.map((t) => t.id)).toEqual([b]);
    expect((await listTransactions(db, user, { q: "GROCERIES" })).items.map((t) => t.id)).toEqual([b]);
    expect((await listTransactions(db, user, { q: "面馆" })).items.map((t) => t.id)).toEqual([a]);
    expect((await listTransactions(db, user, { q: "35" })).items.map((t) => t.id)).toEqual([a]);
    expect((await listTransactions(db, user, { q: "120.00" })).items.map((t) => t.id)).toEqual([b]);
  });

  it("returns splits, my share and merchant-rule suggestions", async () => {
    const { db, roomie, a, b, c, d } = await setup();
    const byId = new Map((await listTransactions(db, user)).items.map((t) => [t.id, t]));
    expect(byId.get(a)).toMatchObject({ myShareMinor: 3500, splits: [], suggestedParticipantIds: [roomie], categoryName: "餐饮" });
    expect(byId.get(b)).toMatchObject({ myShareMinor: 6000, suggestedParticipantIds: [] });
    expect(byId.get(b)!.splits).toEqual([
      { participantId: await selfId(db), name: "我", isSelf: true, owedMinor: 6000, paidMinor: 12000 },
      { participantId: roomie, name: "室友", isSelf: false, owedMinor: 6000, paidMinor: 0 },
    ]);
    expect(byId.get(c)!.myShareMinor).toBe(0);
    expect(byId.get(d)!.myShareMinor).toBe(0);
  });

  it("excludes linked and closed rows from spending; refunds subtract, split refunds by my share", async () => {
    const db = await freshDb();
    const roomie = await addParticipant(db, "室友");
    const orig = await addTx(db, { amountMinor: -1000 });
    const linked = await addTx(db, { amountMinor: -1000, source: "icbc_pdf", duplicateOfId: orig });
    const closed = await addTx(db, { amountMinor: -777, status: "closed" });
    const refund = await addTx(db, { amountMinor: 300, kind: "refund" });
    const splitRefund = await addTx(db, { amountMinor: 400, kind: "refund" });
    await addSplit(db, splitRefund, await selfId(db), 200);
    await addSplit(db, splitRefund, roomie, 200);
    const noSelf = await addTx(db, { amountMinor: -900 });
    await addSplit(db, noSelf, roomie, 900);
    const share = new Map((await listTransactions(db, user)).items.map((t) => [t.id, t.myShareMinor]));
    expect([orig, linked, closed, refund, splitRefund, noSelf].map((id) => share.get(id))).toEqual([1000, 0, 0, -300, -200, 0]);
    expect(await monthTotalsForList(db, user, "2026-09")).toMatchObject([{ currency: "CNY", count: 4, spendingMinor: 500 }]);
  });

  it("lists months with counts, newest first", async () => {
    const { db } = await setup();
    expect(await listMonths(db, user)).toEqual([
      { month: "2026-09", count: 3 },
      { month: "2026-08", count: 1 },
    ]);
  });
});

describe("updates", () => {
  it("updateTransaction edits fields and marks the row edited", async () => {
    const db = await freshDb();
    const id = await addTx(db, { amountMinor: -500, merchant: "x" });
    const out = await updateTransaction(db, user, id, { note: " 午饭 ", merchant: "Y", categoryId: await catId(db, "餐饮") });
    expect(out).toMatchObject({ note: "午饭", merchant: "Y", categoryName: "餐饮" });
    expect(out.userEditedAt).not.toBeNull();
    await expect(updateTransaction(db, user, id, { categoryId: await catId(db, "工资") })).rejects.toThrow(LedgerError);
    // Switching kind drops a category that no longer fits.
    expect(await updateTransaction(db, user, id, { kind: "income" })).toMatchObject({ kind: "income", categoryId: null });
    await expect(updateTransaction(db, user, 999, { note: "x" })).rejects.toThrow(LedgerError);
  });

  it("setCategory with applyToMerchant writes the rule and skips user-edited rows", async () => {
    const db = await freshDb();
    const other = await catId(db, "其他");
    const fun = await catId(db, "娱乐");
    const a = await addTx(db, { amountMinor: -100, merchant: "Arcade Club", categoryId: other });
    const b = await addTx(db, { amountMinor: -200, merchant: "Arcade Club", categoryId: other });
    const edited = await addTx(db, { amountMinor: -300, merchant: "Arcade Club", categoryId: other, userEditedAt: "2026-09-01T00:00:00Z" });
    const refund = await addTx(db, { amountMinor: 100, merchant: "Arcade Club", kind: "refund", categoryId: other });
    const income = await addTx(db, { amountMinor: 100, merchant: "Arcade Club", kind: "income" });
    const elsewhere = await addTx(db, { amountMinor: -400, merchant: "Other", categoryId: other });

    expect(await setCategory(db, user, a, fun, { applyToMerchant: true })).toEqual({ affected: 3 });
    const cat = new Map((await db.select().from(transactions)).map((t) => [t.id, t.categoryId]));
    expect([a, b, edited, refund, income, elsewhere].map((id) => cat.get(id))).toEqual([fun, fun, other, fun, null, other]);
    expect(await db.select().from(merchantRules)).toMatchObject([{ merchant: "Arcade Club", categoryId: fun }]);
    // b stays unedited (rule-applied), a is edited.
    const edits = new Map((await db.select().from(transactions)).map((t) => [t.id, t.userEditedAt]));
    expect(edits.get(a)).not.toBeNull();
    expect(edits.get(b)).toBeNull();

    // Updating the rule again overwrites it.
    await setCategory(db, user, b, other, { applyToMerchant: true });
    expect(await db.select().from(merchantRules)).toMatchObject([{ merchant: "Arcade Club", categoryId: other }]);
    expect(await setCategory(db, user, elsewhere, fun, { applyToMerchant: false })).toEqual({ affected: 1 });
    expect(await db.select().from(merchantRules)).toHaveLength(1);
  });

  it("bulkUpdate applies a category to fitting rows or a kind to all", async () => {
    const db = await freshDb();
    const a = await addTx(db, { amountMinor: -100 });
    const b = await addTx(db, { amountMinor: -200 });
    const inc = await addTx(db, { amountMinor: 300 });
    expect(await bulkUpdate(db, user, [a, b, inc], { categoryId: await catId(db, "买菜") })).toEqual({ updated: 2, skippedSplit: 0 });
    expect(await bulkUpdate(db, user, [a, b], { kind: "transfer" })).toEqual({ updated: 2, skippedSplit: 0 });
    expect((await db.select().from(transactions).where(eq(transactions.id, a)).limit(1))[0]).toMatchObject({ kind: "transfer" });
    expect(await bulkUpdate(db, user, [], { kind: "expense" })).toEqual({ updated: 0, skippedSplit: 0 });
  });

  it("kind changes are refused on split rows; bulk skips and reports them", async () => {
    const db = await freshDb();
    const roomie = await addParticipant(db, "室友");
    const split = await addTx(db, { amountMinor: -1000, categoryId: await catId(db, "买菜") });
    await addSplit(db, split, await selfId(db), 500, 1000);
    await addSplit(db, split, roomie, 500);
    const plain = await addTx(db, { amountMinor: -2000, categoryId: await catId(db, "买菜") });
    await expect(updateTransaction(db, user, split, { kind: "transfer" })).rejects.toThrow(expect.objectContaining({ code: "ledger_kind_change_on_split" }));
    expect(await updateTransaction(db, user, split, { kind: "refund" })).toMatchObject({ kind: "refund" });
    expect(await updateTransaction(db, user, split, { kind: "expense", note: "n" })).toMatchObject({ kind: "expense", note: "n" });
    expect(await bulkUpdate(db, user, [split, plain], { kind: "income" })).toEqual({ updated: 1, skippedSplit: 1 });
    const rows = new Map((await db.select().from(transactions)).map((t) => [t.id, t]));
    expect(rows.get(split)).toMatchObject({ kind: "expense", categoryId: await catId(db, "买菜") });
    // kind alone clears a category that no longer fits
    expect(rows.get(plain)).toMatchObject({ kind: "income", categoryId: null });
  });

  it("categories: create, rename, archive; system ones are protected", async () => {
    const db = await freshDb();
    const pet = await createCategory(db, user, " 宠物 ", "expense");
    expect(pet).toMatchObject({ name: "宠物", kind: "expense", isSystem: false, archivedAt: null });
    await expect(createCategory(db, user, "餐饮", "expense")).rejects.toThrow(LedgerError);
    expect(await renameCategory(db, user, pet.id, "猫")).toMatchObject({ name: "猫" });
    expect((await archiveCategory(db, user, pet.id)).archivedAt).not.toBeNull();
    expect((await archiveCategory(db, user, pet.id, false)).archivedAt).toBeNull();
    await expect(renameCategory(db, user, await catId(db, "餐饮"), "吃饭")).rejects.toThrow(LedgerError);
    await expect(archiveCategory(db, user, await catId(db, "其他"), true)).rejects.toThrow(LedgerError);
    expect((await listCategories(db, user)).find((c) => c.id === pet.id)?.name).toBe("猫");
  });
});

describe("recategorizeUnedited", () => {
  it("re-cleans merchants and re-derives categories on unedited imported rows only", async () => {
    const db = await freshDb();
    const other = await catId(db, "其他");
    const food = await catId(db, "餐饮");
    const nin = await addTx(db, { amountMinor: -6000, currency: "USD", source: "icbc_pdf", counterpartyRaw: "Nintendo CC1610834036", merchant: "Nintendo CC1610834036", categoryId: other });
    const edited = await addTx(db, { amountMinor: -500, counterpartyRaw: "STEAM GAMES", merchant: "Steam Games", categoryId: food, userEditedAt: "2026-09-01T00:00:00Z" });
    const manual = await addTx(db, { amountMinor: -700, source: "manual", counterpartyRaw: "", merchant: "午饭", categoryId: food });
    const eats = await addTx(db, { amountMinor: -900, counterpartyRaw: "美团外卖", merchant: "美团外卖", categoryId: other, occurredAt: "2026-09-02T00:00:00+08:00" });
    const eatsRefund = await addTx(db, { amountMinor: 900, kind: "refund", counterpartyRaw: "美团外卖", merchant: "美团外卖", categoryId: other, occurredAt: "2026-09-03T00:00:00+08:00" });
    const transfer = await addTx(db, { amountMinor: -100, kind: "transfer", counterpartyRaw: "朋友", merchant: "朋友" });
    const rebate = await addTx(db, { amountMinor: 250, kind: "refund", source: "icbc_pdf", currency: "USD", counterpartyRaw: "CASHBACK REBATE", merchant: "Cashback Rebate", categoryId: await catId(db, "其他收入") });

    expect(await recategorizeUnedited(db, user)).toEqual({ scanned: 5, categoryChanged: 4, merchantChanged: 1, kindChanged: 1 });
    const rows = new Map((await db.select().from(transactions)).map((t) => [t.id, t]));
    expect(rows.get(nin)).toMatchObject({ merchant: "Nintendo", categoryId: await catId(db, "娱乐"), userEditedAt: null });
    expect(rows.get(edited)).toMatchObject({ categoryId: food });
    expect(rows.get(manual)).toMatchObject({ merchant: "午饭", categoryId: food });
    expect(rows.get(eats)!.categoryId).toBe(food);
    expect(rows.get(eatsRefund)!.categoryId).toBe(food);
    expect(rows.get(transfer)!.categoryId).toBeNull();
    expect(rows.get(rebate)).toMatchObject({ kind: "income", categoryId: await catId(db, "返现") });
    // Idempotent.
    expect(await recategorizeUnedited(db, user)).toMatchObject({ categoryChanged: 0, merchantChanged: 0, kindChanged: 0 });
  });
});
