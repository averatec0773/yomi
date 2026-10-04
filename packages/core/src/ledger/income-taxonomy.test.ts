import { categories, type Db, participants, settlements, transactions, userSettings } from "@yomi/db";
import { asc, eq } from "@yomi/db/orm";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { seed } from "../seed";
import { upgradeIncomeTaxonomy } from "./income-taxonomy";
import { addParticipant, addSplit, addTx, user } from "./test-helpers";

// A ledger as earlier versions seeded it: Chinese names only, income = 工资 / 退款 / 转入 / 其他收入, plus a user
// category 利息 (interest). Fictional people (Jordan Park, Sam Rivera) and card tails 3141 / 5501 only.
const OLD_EXPENSE = ["餐饮", "买菜", "交通", "购物", "日用", "居住", "娱乐", "订阅", "医疗", "教育", "旅行", "人情", "公益", "其他"];
const OLD_INCOME = ["工资", "退款", "转入", "其他收入"];

async function oldLedger(): Promise<Db> {
  const db = await testDb();
  await db.insert(participants).values({ userId: user.id, name: "我", isSelf: true });
  await db.insert(categories).values([
    ...OLD_EXPENSE.map((name, sort) => ({ userId: user.id, name, kind: "expense" as const, isSystem: true, sort })),
    ...OLD_INCOME.map((name, sort) => ({ userId: user.id, name, kind: "income" as const, isSystem: true, sort })),
    { userId: user.id, name: "利息", kind: "income" as const, isSystem: false, sort: 4 },
  ]);
  return db;
}

async function cat(db: Db, name: string) {
  return (await db.select().from(categories).where(eq(categories.name, name)).limit(1))[0]!;
}

const edited = "2026-09-20T00:00:00.000Z";

async function fixtures(db: Db) {
  const id = async (name: string) => (await cat(db, name)).id;
  const [transfersIn, refunds, otherIncome, dining] = [await id("转入"), await id("退款"), await id("其他收入"), await id("餐饮")];
  const boa = { source: "boa_csv" as const, currency: "USD" };
  const t = {
    zelleFriend: await addTx(db, { ...boa, amountMinor: 2500, sourceCategory: "Zelle", counterpartyRaw: "Jordan Park", merchant: "Jordan Park", categoryId: transfersIn }),
    zelleEdited: await addTx(db, { ...boa, amountMinor: 80000, sourceCategory: "Zelle", counterpartyRaw: "Avery Lin", merchant: "Avery Lin", categoryId: transfersIn, userEditedAt: edited }),
    wireIn: await addTx(db, { ...boa, amountMinor: 300000, sourceCategory: "Wire", counterpartyRaw: "SAM RIVERA", merchant: "Sam Rivera", categoryId: transfersIn }),
    purchase: await addTx(db, { amountMinor: -3800, counterpartyRaw: "Corner Cafe", merchant: "Corner Cafe", categoryId: dining, occurredAt: "2026-09-01T12:00:00+08:00" }),
    refundUnedited: await addTx(db, { amountMinor: 3800, counterpartyRaw: "Corner Cafe", merchant: "Corner Cafe", categoryId: refunds }),
    refundEdited: await addTx(db, { amountMinor: 1200, counterpartyRaw: "Book Nook", merchant: "Book Nook", categoryId: refunds, userEditedAt: edited }),
    rewards: await addTx(db, { ...boa, amountMinor: 1500, sourceCategory: "Rewards", counterpartyRaw: "CASH REWARDS CREDIT", merchant: "Cash Rewards Credit", categoryId: otherIncome }),
    interest: await addTx(db, { ...boa, amountMinor: 42, sourceCategory: "Interest", counterpartyRaw: "Interest Earned", merchant: "Interest Earned", categoryId: otherIncome }),
    wages: await addTx(db, { source: "plaid", currency: "USD", amountMinor: 250000, sourceCategory: "INCOME/INCOME_WAGES", counterpartyRaw: "ACME PAYROLL", merchant: "Acme Payroll", categoryId: otherIncome }),
    plaidZelle: await addTx(db, { source: "plaid", currency: "USD", amountMinor: 2000, sourceCategory: "TRANSFER_IN/TRANSFER_IN_FROM_APPS", counterpartyRaw: "Zelle from Jordan Park", merchant: "Zelle from Jordan Park", categoryId: otherIncome }),
    plaidWire: await addTx(db, { source: "plaid", currency: "USD", amountMinor: 500000, kind: "transfer", sourceCategory: "TRANSFER_IN/TRANSFER_IN_WIRE", counterpartyRaw: "WIRE TYPE:INTL IN", merchant: "Wire Type Intl In" }),
    rebate: await addTx(db, { source: "icbc_pdf", currency: "USD", amountMinor: 50, counterpartyRaw: "CASHBACK REBATE", merchant: "Cashback Rebate", categoryId: otherIncome }),
    yieldCny: await addTx(db, { amountMinor: 12, counterpartyRaw: "余额宝-2026.09.01-收益发放", merchant: "余额宝", categoryId: otherIncome }),
    manual: await addTx(db, { source: "manual", amountMinor: 900, merchant: "Cashback", categoryId: otherIncome }),
    settled: await addTx(db, { ...boa, amountMinor: 1800, kind: "transfer", sourceCategory: "Zelle", counterpartyRaw: "Jordan Park", merchant: "Jordan Park", categoryId: transfersIn }),
    split: await addTx(db, { amountMinor: 600, kind: "refund", counterpartyRaw: "Pizza Place", merchant: "Pizza Place", categoryId: refunds }),
    closed: await addTx(db, { ...boa, amountMinor: 700, sourceCategory: "Zelle", counterpartyRaw: "Jordan Park", merchant: "Jordan Park", categoryId: transfersIn, status: "closed" }),
    duplicate: 0,
  };
  t.duplicate = await addTx(db, { ...boa, amountMinor: 2500, sourceCategory: "Zelle", counterpartyRaw: "Jordan Park", merchant: "Jordan Park", categoryId: transfersIn, duplicateOfId: t.zelleFriend });
  const jordan = await addParticipant(db, "Jordan Park");
  await db.insert(settlements).values({ userId: user.id, participantId: jordan, amountMinor: 1800, currency: "USD", settledOn: "2026-09-10", transactionId: t.settled, priorKind: "income" });
  await addSplit(db, t.split, jordan, -300);
  return t;
}

const snapshot = async (db: Db) => ({
  categories: await db.select().from(categories).orderBy(asc(categories.id)),
  transactions: await db.select().from(transactions).orderBy(asc(transactions.id)),
});

describe("upgradeIncomeTaxonomy", () => {
  it("keys and adds categories, archives 退款 and 转入, re-files each class of row, and leaves locked rows alone", async () => {
    const db = await oldLedger();
    const interestBefore = await cat(db, "利息");
    const t = await fixtures(db);
    const before = await snapshot(db);

    expect(await seed(db)).toEqual({ archived: 2, refundsRebooked: 1, transfersInRecategorized: 2, editedMoved: 2, incomeRecategorized: 5, skippedLocked: 4 });

    const cats = await db.select().from(categories).orderBy(asc(categories.id));
    expect(new Set(cats.map((c) => c.name)).size).toBe(cats.length);
    expect(cats.filter((c) => c.kind === "income" && c.archivedAt == null).map((c) => c.key).sort()).toEqual(
      ["bonus", "cashback", "familySupport", "interest", "otherIncome", "reimbursement", "salary", "sideIncome"],
    );
    expect(cats.filter((c) => c.archivedAt != null).map((c) => [c.name, c.key])).toEqual([["退款", "refunds"], ["转入", "transfersIn"]]);
    expect(await cat(db, "利息")).toMatchObject({ id: interestBefore.id, key: "interest", isSystem: true });
    expect(await cat(db, "报销")).toMatchObject({ key: "reimbursement", countsAsIncome: false });
    expect(cats.every((c) => c.key != null)).toBe(true);

    const rows = new Map((await db.select().from(transactions)).map((r) => [r.id, r]));
    const of = async (id: number) => {
      const r = rows.get(id)!;
      return { kind: r.kind, category: r.categoryId == null ? null : (cats.find((c) => c.id === r.categoryId)!.name), edited: r.userEditedAt != null };
    };
    expect(await of(t.zelleFriend)).toEqual({ kind: "income", category: "其他收入", edited: false });
    expect(await of(t.zelleEdited)).toEqual({ kind: "income", category: "其他收入", edited: true });
    expect(await of(t.wireIn)).toEqual({ kind: "income", category: "其他收入", edited: false });
    expect(await of(t.refundUnedited)).toEqual({ kind: "refund", category: "餐饮", edited: false });
    expect(await of(t.refundEdited)).toEqual({ kind: "income", category: "其他收入", edited: true });
    expect(await of(t.rewards)).toEqual({ kind: "income", category: "返现", edited: false });
    expect(await of(t.interest)).toEqual({ kind: "income", category: "利息", edited: false });
    expect(await of(t.wages)).toEqual({ kind: "income", category: "工资", edited: false });
    expect(await of(t.plaidZelle)).toEqual({ kind: "income", category: "其他收入", edited: false });
    expect(await of(t.plaidWire)).toEqual({ kind: "transfer", category: null, edited: false });
    expect(await of(t.rebate)).toEqual({ kind: "income", category: "返现", edited: false });
    expect(await of(t.yieldCny)).toEqual({ kind: "income", category: "利息", edited: false });
    // Manual rows, split, settled, closed and duplicate rows keep everything.
    for (const id of [t.manual, t.settled, t.split, t.closed, t.duplicate, t.purchase]) {
      expect(rows.get(id), String(id)).toEqual(before.transactions.find((r) => r.id === id));
    }
    // No unedited, open, unlocked row is left on an archived category.
    const archived = new Set(cats.filter((c) => c.archivedAt != null).map((c) => c.id));
    const left = [...rows.values()].filter((r) => r.categoryId != null && archived.has(r.categoryId));
    expect(left.map((r) => r.id).sort()).toEqual([t.settled, t.split, t.closed, t.duplicate].sort());
  });

  it("is idempotent: a second run (marker removed) changes nothing; with the marker it does not run", async () => {
    const db = await oldLedger();
    await fixtures(db);
    await seed(db);
    const once = await snapshot(db);
    expect(await upgradeIncomeTaxonomy(db, user)).toBeNull();
    await db.delete(userSettings).where(eq(userSettings.key, "income_taxonomy"));
    expect(await upgradeIncomeTaxonomy(db, user)).toEqual({ archived: 0, refundsRebooked: 0, transfersInRecategorized: 0, editedMoved: 0, incomeRecategorized: 0, skippedLocked: 4 });
    expect(await snapshot(db)).toEqual(once);
    await seed(db);
    expect(await snapshot(db)).toEqual(once);
  });

  it("a new ledger gets the keyed categories and nothing to archive", async () => {
    const db = await testDb();
    expect(await seed(db)).toEqual({ archived: 0, refundsRebooked: 0, transfersInRecategorized: 0, editedMoved: 0, incomeRecategorized: 0, skippedLocked: 0 });
    expect((await db.select().from(categories)).filter((c) => c.key === "refunds" || c.key === "transfersIn")).toEqual([]);
    expect(await seed(db)).toBeNull();
  });
});
