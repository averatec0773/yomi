import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accounts, categories, closeDb, createDb, type Db, merchantRules, migrate, participants, settlements, transactions, transactionSplits } from "@yomi/db";
import { testDb, migratedTestDir } from "@yomi/db/testing";
import type { DeclaredTotals, NormalizedRow, ParseResult, SourceId } from "@yomi/importers";
import { asc, eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { seed } from "../seed";
import { createParticipant, recordSettlement } from "../split";
import { getCurrentUser } from "../user";
import { parsePaymentMethod, resolveAccountSpec } from "./accounts";
import { computeDedupKeys } from "./dedup";
import { commitImport, ImportError, listBatches, previewImport, revertBatch } from "./pipeline";

const user = getCurrentUser();

async function freshDb(): Promise<Db> {
  const db = await testDb();
  await seed(db);
  return db;
}

let lineNo = 0;
function row(p: Partial<NormalizedRow> & Pick<NormalizedRow, "source" | "amountMinor">): NormalizedRow {
  const out = p.amountMinor < 0;
  return {
    lineNo: ++lineNo,
    externalId: null,
    occurredAt: "2026-09-01T12:00:00+08:00",
    currency: "CNY",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: out ? "out" : "in",
    kind: out ? "expense" : "income",
    status: "ok",
    counterparty: "某商户",
    description: "",
    sourceCategory: null,
    paymentMethod: null,
    raw: { note: "synthetic" },
    ...p,
  };
}

function fakeParse(source: SourceId, rows: NormalizedRow[], declared: DeclaredTotals = {}) {
  return async (): Promise<ParseResult> => ({ source, rows, declared, warnings: [] });
}

const bytes = (s: string) => new TextEncoder().encode(s);

async function catName(db: Db, id: number | null) {
  if (id == null) return null;
  return (await db.select().from(categories).where(eq(categories.id, id)).limit(1))[0]?.name ?? null;
}

describe("account resolution", () => {
  it("parses bank cards and ignores the part after &", () => {
    expect(parsePaymentMethod("中国银行储蓄卡(5501)")).toEqual({
      institution: "中国银行",
      cardType: "储蓄卡",
      kind: "debit_card",
      last4: "5501",
    });
    expect(parsePaymentMethod("工商银行信用卡(7702)&工商银行立减金")).toMatchObject({
      institution: "工商银行",
      kind: "credit_card",
      last4: "7702",
    });
    for (const pm of ["账户余额", "账户余额(个人余额)", "零钱", "", null]) expect(parsePaymentMethod(pm)).toBeNull();
  });

  it("falls back to the platform wallet", () => {
    expect(resolveAccountSpec(row({ source: "alipay", amountMinor: -1, paymentMethod: "账户余额" }), "CNY")).toMatchObject({
      name: "支付宝余额",
      kind: "wallet",
    });
    expect(resolveAccountSpec(row({ source: "wechat", amountMinor: -1, paymentMethod: "零钱" }), "CNY")).toMatchObject({
      name: "微信零钱",
      kind: "wallet",
    });
  });

  it("creates each account once, with names like 中国银行储蓄卡 5501, and reuses them next time", async () => {
    const db = await freshDb();
    const rows = [
      row({ source: "alipay", amountMinor: -100, externalId: "a1", paymentMethod: "中国银行储蓄卡(5501)" }),
      row({ source: "alipay", amountMinor: -200, externalId: "a2", paymentMethod: "工商银行信用卡(7702)&工商银行立减金" }),
      row({ source: "alipay", amountMinor: -300, externalId: "a3", paymentMethod: "账户余额" }),
      row({ source: "alipay", amountMinor: -400, externalId: "a4", paymentMethod: "中国银行储蓄卡(5501)" }),
    ];
    const preview = await previewImport(db, user, fakeParse("alipay", rows), bytes("f1"), "a.csv");
    expect(preview.accountsToCreate.map((a) => a.name).sort()).toEqual(
      ["中国银行储蓄卡 5501", "工商银行信用卡 7702", "支付宝余额"].sort(),
    );
    expect(await db.select().from(accounts)).toHaveLength(0);

    await commitImport(db, user, fakeParse("alipay", rows), bytes("f1"), "a.csv");
    const accs = await db.select().from(accounts);
    expect(accs).toHaveLength(3);
    expect(accs.find((a) => a.last4 === "5501")).toMatchObject({ kind: "debit_card", currency: "CNY", institution: "中国银行" });
    const tx = await db.select().from(transactions);
    expect(new Set(tx.filter((t) => t.sourceRef === "a1" || t.sourceRef === "a4").map((t) => t.accountId)).size).toBe(1);

    const more = [row({ source: "alipay", amountMinor: -5, externalId: "a5", paymentMethod: "中国银行储蓄卡(5501)" })];
    const r2 = await commitImport(db, user, fakeParse("alipay", more), bytes("f2"), "b.csv");
    expect(r2.accountsToCreate).toHaveLength(0);
    expect(await db.select().from(accounts)).toHaveLength(3);
  });

  it("puts one card on one account whatever each source calls it", async () => {
    const db = await freshDb();
    // As bank sync would have named it.
    const [synced] = await db
      .insert(accounts)
      .values({ userId: user.id, name: "ICBC Debit 1234", kind: "debit_card", institution: "工商银行", last4: "1234", currency: "CNY" })
      .returning();
    const alipay = [row({ source: "alipay", amountMinor: -100, externalId: "a1", paymentMethod: "工商银行储蓄卡(1234)" })];
    const wechat = [row({ source: "wechat", amountMinor: -200, externalId: "w1", paymentMethod: "工商银行借记卡(1234)" })];
    expect((await previewImport(db, user, fakeParse("alipay", alipay), bytes("a"), "a.csv")).accountsToCreate).toEqual([]);
    await commitImport(db, user, fakeParse("alipay", alipay), bytes("a"), "a.csv");
    await commitImport(db, user, fakeParse("wechat", wechat), bytes("w"), "w.xlsx");
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(new Set((await db.select().from(transactions)).map((t) => t.accountId))).toEqual(new Set([synced!.id]));
  });

  it("uses the first row currency for ICBC PDF accounts", async () => {
    const db = await freshDb();
    const rows = [
      row({ source: "icbc_pdf", amountMinor: -1234, currency: "USD", paymentMethod: "工商银行信用卡(3141)" }),
      row({ source: "icbc_pdf", amountMinor: -500, currency: "HKD", paymentMethod: "工商银行信用卡(3141)" }),
    ];
    await commitImport(db, user, fakeParse("icbc_pdf", rows), bytes("pdf"), "icbc.pdf");
    const accs = await db.select().from(accounts);
    expect(accs).toHaveLength(1);
    expect(accs[0]).toMatchObject({ name: "工商银行信用卡 3141", kind: "credit_card", currency: "USD" });
  });
});

describe("dedup", () => {
  it("second import of overlapping rows inserts only the new ones", async () => {
    const db = await freshDb();
    const a = row({ source: "wechat", amountMinor: -100, externalId: "w1" });
    const b = row({ source: "wechat", amountMinor: -200, externalId: "w2" });
    const c = row({ source: "wechat", amountMinor: -300, externalId: "w3" });
    const first = await commitImport(db, user, fakeParse("wechat", [a, b]), bytes("jan"), "jan.xlsx");
    expect(first.inserted).toBe(2);

    const preview = await previewImport(db, user, fakeParse("wechat", [b, c]), bytes("feb"), "feb.xlsx");
    expect(preview).toMatchObject({ rowsTotal: 2, newCount: 1, dupCount: 1, alreadyImported: false });
    const second = await commitImport(db, user, fakeParse("wechat", [b, c]), bytes("feb"), "feb.xlsx");
    expect(second).toMatchObject({ inserted: 1, skippedDup: 1 });
    expect((await db.select().from(transactions)).map((t) => t.dedupKey).sort()).toEqual([
      "wechat:w1",
      "wechat:w2",
      "wechat:w3",
    ]);
  });

  it("keeps identical same-day same-amount rows without ids (ordinal), and dedups them on re-import", async () => {
    const db = await freshDb();
    const mk = () =>
      row({ source: "icbc_pdf", amountMinor: -350, currency: "USD", counterparty: "SQ *COFFEE CART", paymentMethod: "工商银行信用卡(3141)" });
    const rows = [mk(), mk()];
    const keys = computeDedupKeys(rows, ["k", "k"]);
    expect(keys[0]).toMatch(/^icbc_pdf:h:[0-9a-f]{64}:0$/);
    expect(keys[1]).toBe(keys[0]!.replace(/:0$/, ":1"));

    const r1 = await commitImport(db, user, fakeParse("icbc_pdf", rows), bytes("p1"), "p1.pdf");
    expect(r1.inserted).toBe(2);
    const r2 = await commitImport(db, user, fakeParse("icbc_pdf", [mk(), mk(), mk()]), bytes("p2"), "p2.pdf");
    expect(r2).toMatchObject({ inserted: 1, skippedDup: 2 });
    expect(await db.select().from(transactions)).toHaveLength(3);
  });

  it("does not collide on a repeated external id inside one file", () => {
    const rows = [row({ source: "alipay", amountMinor: -1, externalId: "x" }), row({ source: "alipay", amountMinor: 1, externalId: "x" })];
    expect(computeDedupKeys(rows, ["a", "a"])).toEqual(["alipay:x", "alipay:x:1"]);
  });
});

describe("fuzzy linking", () => {
  it("links a new ICBC row to the Alipay row paid with the same card within ±3 days", async () => {
    const db = await freshDb();
    const ali = row({
      source: "alipay",
      externalId: "ali-1",
      amountMinor: -8800,
      occurredAt: "2026-09-10T20:00:00+08:00",
      paymentMethod: "工商银行信用卡(3141)&工商银行立减金",
    });
    const aliOtherCard = row({
      source: "alipay",
      externalId: "ali-2",
      amountMinor: -500,
      occurredAt: "2026-09-10T20:00:00+08:00",
      paymentMethod: "中国银行储蓄卡(5501)",
    });
    await commitImport(db, user, fakeParse("alipay", [ali, aliOtherCard]), bytes("ali"), "ali.csv");

    const bank = [
      row({ source: "icbc_pdf", amountMinor: -8800, occurredAt: "2026-09-12T00:00:00+08:00", paymentMethod: "工商银行信用卡(3141)" }),
      row({ source: "icbc_pdf", amountMinor: -500, occurredAt: "2026-09-10T00:00:00+08:00", paymentMethod: "工商银行信用卡(3141)" }),
      row({ source: "icbc_pdf", amountMinor: -8800, occurredAt: "2026-09-20T00:00:00+08:00", paymentMethod: "工商银行信用卡(3141)" }),
    ];
    const preview = await previewImport(db, user, fakeParse("icbc_pdf", bank), bytes("bank"), "bank.pdf");
    expect(preview.linkCount).toBe(1);
    const res = await commitImport(db, user, fakeParse("icbc_pdf", bank), bytes("bank"), "bank.pdf");
    expect(res.linked).toBe(1);

    const aliRow = (await db.select().from(transactions).where(eq(transactions.sourceRef, "ali-1")).limit(1))[0]!;
    const bankRows = await db.select().from(transactions).where(eq(transactions.source, "icbc_pdf")).orderBy(asc(transactions.id));
    expect(bankRows.map((t) => t.duplicateOfId)).toEqual([aliRow.id, null, null]);
    // Linked rows are excluded from the spending preview.
    expect(res.spending).toEqual([{ currency: "CNY", count: 2, spendingMinor: 9300 }]);
  });
});

describe("reverse linking (bank first, wallet later)", () => {
  it("links an existing ICBC row to the new Alipay row paid with the same card", async () => {
    const db = await freshDb();
    const bank = [
      row({ source: "icbc_pdf", amountMinor: -8800, occurredAt: "2026-09-12T00:00:00+08:00", paymentMethod: "工商银行信用卡(3141)" }),
      row({ source: "icbc_pdf", amountMinor: -500, occurredAt: "2026-09-10T00:00:00+08:00", paymentMethod: "工商银行信用卡(3141)" }),
    ];
    await commitImport(db, user, fakeParse("icbc_pdf", bank), bytes("rb-bank"), "bank.pdf");
    const ali = [
      row({ source: "alipay", externalId: "rb-1", amountMinor: -8800, occurredAt: "2026-09-10T20:00:00+08:00", paymentMethod: "工商银行信用卡(3141)" }),
      row({ source: "alipay", externalId: "rb-2", amountMinor: -500, occurredAt: "2026-09-10T20:00:00+08:00", paymentMethod: "中国银行储蓄卡(5501)" }),
    ];
    const preview = await previewImport(db, user, fakeParse("alipay", ali), bytes("rb-ali"), "ali.csv");
    expect(preview.linkCount).toBe(1);
    const res = await commitImport(db, user, fakeParse("alipay", ali), bytes("rb-ali"), "ali.csv");
    expect(res.linked).toBe(1);
    const aliRow = (await db.select().from(transactions).where(eq(transactions.sourceRef, "rb-1")).limit(1))[0]!;
    const bankRows = await db.select().from(transactions).where(eq(transactions.source, "icbc_pdf")).orderBy(asc(transactions.id));
    expect(bankRows.map((t) => t.duplicateOfId)).toEqual([aliRow.id, null]);
    expect(aliRow.duplicateOfId).toBeNull();
  });

  it("leaves an edited, split or settled bank row alone and warns", async () => {
    const db = await freshDb();
    const bank = [row({ source: "icbc_pdf", amountMinor: -8800, occurredAt: "2026-09-12T00:00:00+08:00", paymentMethod: "工商银行信用卡(3141)" })];
    await commitImport(db, user, fakeParse("icbc_pdf", bank), bytes("rb2-bank"), "bank.pdf");
    const b = (await db.select().from(transactions).limit(1))[0]!;
    await db.update(transactions).set({ userEditedAt: new Date().toISOString() }).where(eq(transactions.id, b.id));
    const ali = [row({ source: "alipay", externalId: "rb2-1", amountMinor: -8800, occurredAt: "2026-09-11T20:00:00+08:00", paymentMethod: "工商银行信用卡(3141)" })];
    const res = await commitImport(db, user, fakeParse("alipay", ali), bytes("rb2-ali"), "ali.csv");
    expect(res.linked).toBe(0);
    expect(res.warnings.find((w) => w.code === "import_link_locked")).toMatchObject({ params: { reason: "edited" } });
    expect((await db.select().from(transactions).where(eq(transactions.id, b.id)).limit(1))[0]!.duplicateOfId).toBeNull();
  });
});

describe("status, categories and batches", () => {
  it("stores closed rows with status closed", async () => {
    const db = await freshDb();
    const rows = [row({ source: "alipay", externalId: "c1", amountMinor: -999, status: "closed" })];
    const res = await commitImport(db, user, fakeParse("alipay", rows), bytes("closed"), "c.csv");
    expect(res.closedCount).toBe(1);
    expect(res.spending).toEqual([]);
    expect((await db.select().from(transactions).limit(1))[0]).toMatchObject({ status: "closed", sourceRef: "c1" });
  });

  it("categorizes by rule, keyword, source category; refunds follow the purchase; transfers get none", async () => {
    const db = await freshDb();
    const shopping = (await db.select().from(categories).where(eq(categories.name, "旅行")).limit(1))[0]!;
    const roommate = (await db.insert(participants).values({ userId: user.id, name: "室友" }).returning())[0]!;
    await db.insert(merchantRules).values({ userId: user.id, merchant: "Acme Travel", categoryId: shopping.id, participantIds: [roommate.id] });
    const rows = [
      row({ source: "icbc_pdf", amountMinor: -100, currency: "USD", counterparty: "ACME TRAVEL 0042 AUSTIN TX" }),
      row({ source: "icbc_pdf", amountMinor: -200, currency: "USD", counterparty: "UBER *EATS PENDING" }),
      row({ source: "icbc_pdf", amountMinor: -300, currency: "USD", counterparty: "UBER *TRIP" }),
      row({ source: "icbc_pdf", amountMinor: -400, currency: "USD", counterparty: "TST* NICE BAKERY" }),
      row({ source: "icbc_pdf", amountMinor: 400, currency: "USD", counterparty: "TST* NICE BAKERY", kind: "refund" }),
      row({ source: "icbc_pdf", amountMinor: 50, currency: "USD", counterparty: "CASHBACK REBATE" }),
      row({ source: "icbc_pdf", amountMinor: -600, currency: "USD", counterparty: "SOMEWHERE ODD" }),
      row({ source: "icbc_pdf", amountMinor: -700, currency: "USD", counterparty: "CARD PAYMENT", kind: "transfer", direction: "neutral" }),
    ];
    const res = await commitImport(db, user, fakeParse("icbc_pdf", rows), bytes("cats"), "cats.pdf");
    const tx = await db.select().from(transactions).orderBy(asc(transactions.id));
    const txCats = [];
    for (const t of tx) txCats.push(await catName(db, t.categoryId));
    expect(txCats).toEqual(["旅行", "餐饮", "交通", "餐饮", "餐饮", "返现", "其他", null]);
    expect(tx[0]!.merchant).toBe("Acme Travel");
    expect(res.participantSuggestions).toEqual([
      { lineNo: rows[0]!.lineNo, transactionId: tx[0]!.id, merchant: "Acme Travel", participantIds: [roommate.id] },
    ]);
    expect(await db.select().from(transactionSplits)).toHaveLength(0);

    const cn = [
      row({ source: "alipay", externalId: "s1", amountMinor: -100, counterparty: "某面馆", sourceCategory: "餐饮美食" }),
      row({ source: "alipay", externalId: "s2", amountMinor: 100, counterparty: "某面馆", sourceCategory: "退款", kind: "refund" }),
      row({ source: "wechat", externalId: "s3", amountMinor: -500, counterparty: "朋友", sourceCategory: "微信红包（单发）" }),
      row({ source: "wechat", externalId: "s4", amountMinor: -100, counterparty: "腾讯公益", sourceCategory: "分分捐" }),
    ];
    await commitImport(db, user, fakeParse("alipay", cn), bytes("cn"), "cn.csv");
    const cnTx = await db.select().from(transactions).where(eq(transactions.importBatchId, 2)).orderBy(asc(transactions.id));
    const cnCats = [];
    for (const t of cnTx) cnCats.push(await catName(db, t.categoryId));
    expect(cnCats).toEqual(["餐饮", "餐饮", "人情", "公益"]);
  });

  it("refuses to re-import a committed file unless forced", async () => {
    const db = await freshDb();
    const rows = [row({ source: "alipay", externalId: "r1", amountMinor: -1 })];
    await commitImport(db, user, fakeParse("alipay", rows), bytes("same"), "x.csv");
    const preview = await previewImport(db, user, fakeParse("alipay", rows), bytes("same"), "renamed.csv");
    expect(preview).toMatchObject({ alreadyImported: true, existingBatchId: 1, newCount: 0 });
    await expect(commitImport(db, user, fakeParse("alipay", rows), bytes("same"), "x.csv")).rejects.toMatchObject({
      name: "ImportError",
      kind: "conflict",
      code: "import_already_imported",
      params: { batchId: 1 },
    });
    const forced = await commitImport(db, user, fakeParse("alipay", rows), bytes("same"), "x.csv", { force: true });
    expect(forced).toMatchObject({ inserted: 0, skippedDup: 1 });
    // The empty forced batch is not listed (nothing to undo); the original stays.
    expect((await listBatches(db, user)).map((b) => b.id)).toEqual([1]);
  });

  it("revert deletes unedited rows (with splits and settlements) and keeps user-edited ones", async () => {
    const db = await freshDb();
    const rows = [
      row({ source: "wechat", externalId: "v1", amountMinor: -100 }),
      row({ source: "wechat", externalId: "v2", amountMinor: -200 }),
      row({ source: "wechat", externalId: "v3", amountMinor: -300 }),
    ];
    const res = await commitImport(db, user, fakeParse("wechat", rows), bytes("rev"), "rev.xlsx");
    const [t1, t2] = await db.select().from(transactions).orderBy(asc(transactions.id));
    await db.update(transactions).set({ userEditedAt: new Date().toISOString() }).where(eq(transactions.id, t1!.id));
    const self = (await db.select().from(participants).limit(1))[0]!;
    await db.insert(transactionSplits)
      .values({ userId: user.id, transactionId: t2!.id, participantId: self.id, currency: "CNY", owedMinor: 200, method: "exact" });
    await db.insert(settlements)
      .values({ userId: user.id, participantId: self.id, amountMinor: 200, currency: "CNY", settledOn: "2026-09-02", transactionId: t2!.id });

    expect(await revertBatch(db, user, res.batchId)).toEqual({ batchId: res.batchId, deleted: 2, keptEdited: 1 });
    expect((await db.select().from(transactions)).map((t) => t.id)).toEqual([t1!.id]);
    expect(await db.select().from(transactionSplits)).toHaveLength(0);
    expect(await db.select().from(settlements)).toHaveLength(0);
    expect((await listBatches(db, user))[0]).toMatchObject({ status: "reverted" });
    await expect(revertBatch(db, user, res.batchId)).rejects.toThrow(ImportError);
    await expect(revertBatch(db, user, 999)).rejects.toThrow(ImportError);

    // A reverted file may be imported again.
    const again = await commitImport(db, user, fakeParse("wechat", rows), bytes("rev"), "rev.xlsx");
    expect(again).toMatchObject({ inserted: 2, skippedDup: 1 });
  });

  it("revert keeps a row linked to a manually recorded settlement", async () => {
    const db = await freshDb();
    const res = await commitImport(db, user, fakeParse("wechat", [row({ source: "wechat", externalId: "ms1", amountMinor: 2000, sourceCategory: "转账" })]), bytes("ms"), "ms.xlsx");
    const t = (await db.select().from(transactions).limit(1))[0]!;
    const p = await createParticipant(db, user, "A");
    await recordSettlement(db, user, { participantId: p.id, amountMinor: 2000, currency: "CNY", settledOn: "2026-09-01", transactionId: t.id });
    expect(await revertBatch(db, user, res.batchId)).toMatchObject({ deleted: 0, keptEdited: 1 });
    expect(await db.select().from(settlements)).toHaveLength(1);
  });

  it("revert clears links from rows of other batches", async () => {
    const db = await freshDb();
    const ali = row({ source: "alipay", externalId: "L1", amountMinor: -100, paymentMethod: "工商银行信用卡(3141)" });
    const a = await commitImport(db, user, fakeParse("alipay", [ali]), bytes("L-ali"), "l.csv");
    const bank = row({ source: "icbc_pdf", amountMinor: -100, paymentMethod: "工商银行信用卡(3141)" });
    await commitImport(db, user, fakeParse("icbc_pdf", [bank]), bytes("L-bank"), "l.pdf");
    await revertBatch(db, user, a.batchId);
    expect((await db.select().from(transactions)).map((t) => t.duplicateOfId)).toEqual([null]);
  });

  it("reports reconciliation mismatches against the declared totals", async () => {
    const db = await freshDb();
    const rows = [
      row({ source: "alipay", externalId: "m1", amountMinor: -1000 }),
      row({ source: "alipay", externalId: "m2", amountMinor: -250 }),
      row({ source: "alipay", externalId: "m3", amountMinor: 500 }),
      row({ source: "alipay", externalId: "m4", amountMinor: -70, direction: "neutral", kind: "transfer" }),
    ];
    const good = await previewImport(
      db,
      user,
      fakeParse("alipay", rows, {
        count: 4,
        expense: { count: 2, minor: 1250 },
        income: { count: 1, minor: 500 },
        neutral: { count: 1, minor: 70 },
      }),
      bytes("ok"),
      "ok.csv",
    );
    expect(good.reconciliation.ok).toBe(true);
    expect(good.warnings).toEqual([]);

    const bad = await previewImport(
      db,
      user,
      fakeParse("alipay", rows, { count: 5, expense: { count: 2, minor: 1251 }, income: { count: 1, minor: 500 } }),
      bytes("bad"),
      "bad.csv",
    );
    expect(bad.reconciliation.ok).toBe(false);
    expect(bad.reconciliation.count).toEqual({ declared: 5, parsed: 4, ok: false });
    expect(bad.reconciliation.buckets.find((b) => b.bucket === "expense")).toMatchObject({
      declared: { count: 2, minor: 1251 },
      parsed: { count: 2, minor: 1250 },
      ok: false,
    });
    expect(bad.reconciliation.buckets.find((b) => b.bucket === "neutral")).toMatchObject({ declared: null, ok: true });
    expect(bad.warnings).toHaveLength(2);

    const committed = await commitImport(
      db,
      user,
      fakeParse("alipay", rows, { count: 5 }),
      bytes("bad"),
      "bad.csv",
    );
    expect(JSON.parse(JSON.stringify((await listBatches(db, user))[0]))).toMatchObject({
      id: committed.batchId,
      declared: { count: 5 },
      parsed: { count: 4, expense: { count: 2, minor: 1250 }, neutral: { count: 1, minor: 70 } },
    });
  });
});

describe("backups around import and revert", { timeout: 30_000 }, () => {
  it("backs up a PGlite directory before commit and before revert, unless backup: false", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yomi-pipe-"));
    await migratedTestDir(path.join(dir, "ledger"));
    const db = await createDb(path.join(dir, "ledger"));
    try {
      await migrate(db);
      await seed(db);
      const list = () => (existsSync(path.join(dir, "backups")) ? readdirSync(path.join(dir, "backups")).sort() : []);

      await commitImport(db, user, fakeParse("wechat", [row({ source: "wechat", amountMinor: -100 })]), bytes("a"), "a.csv", {
        backup: false,
      });
      expect(list()).toEqual([]);
      const r = await commitImport(db, user, fakeParse("wechat", [row({ source: "wechat", amountMinor: -200 })]), bytes("b"), "b.csv");
      expect(list()).toEqual([expect.stringMatching(/^ledger-\d{8}-\d{6}-pre-import\.tar\.gz$/)]);
      await revertBatch(db, user, r.batchId);
      expect(list().filter((f) => f.endsWith("-pre-revert.tar.gz"))).toHaveLength(1);
    } finally {
      await closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
