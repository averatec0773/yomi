import { accounts } from "@yomi/db";
import { describe, expect, it } from "vitest";
import { catId, freshDb, user } from "../ledger/test-helpers";
import { listTransactions } from "../ledger/transactions";
import { rangeOverview } from "../stats/range";
import { createIncomeEntry, createTransferEntry, quickAccounts } from "./entries";
import { MANUAL_ACCOUNT_NAME } from "./create";

// Fictional accounts: checking 3141, savings 5501.
async function setup() {
  const db = await freshDb();
  const [checking, savings, alipay] = await db
    .insert(accounts)
    .values([
      { userId: user.id, name: "Checking 3141", kind: "debit_card", currency: "USD" },
      { userId: user.id, name: "Savings 5501", kind: "debit_card", currency: "USD" },
      { userId: user.id, name: "支付宝余额", kind: "wallet", currency: "CNY" },
    ])
    .returning({ id: accounts.id });
  return { db, checking: checking!.id, savings: savings!.id, alipay: alipay!.id };
}

const overview = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  (await rangeOverview(db, user, { from: "2026-09-01", to: "2026-09-30" }, { today: "2026-10-01" })).currencies;

describe("typed income and transfers", () => {
  it("lists my accounts with their currencies", async () => {
    const { db, checking } = await setup();
    expect((await quickAccounts(db, user))[0]).toEqual({ id: checking, name: "Checking 3141", currency: "USD" });
  });

  it("books income on the account in an income category, counted in the period's income", async () => {
    const { db, checking } = await setup();
    const salary = await catId(db, "工资");
    const { transactionIds } = await createIncomeEntry(db, user, { amountMinor: 320000, currency: "usd", categoryId: salary, date: "2026-09-15", accountId: checking, note: " Paycheck " });
    const [row] = (await listTransactions(db, user, { id: transactionIds[0] })).items;
    expect(row).toMatchObject({ kind: "income", amountMinor: 320000, currency: "USD", accountId: checking, categoryId: salary, merchant: "Paycheck", source: "manual", occurredOn: "2026-09-15" });
    expect((await overview(db)).find((c) => c.currency === "USD")).toMatchObject({ incomeMinor: 320000 });
  });

  it("without an account lands on the manual cash account; a reimbursement is listed but not counted", async () => {
    const { db } = await setup();
    const { transactionIds } = await createIncomeEntry(db, user, { amountMinor: 4500, currency: "USD", categoryId: await catId(db, "报销"), date: "2026-09-20", accountId: null, note: null });
    const [row] = (await listTransactions(db, user, { id: transactionIds[0] })).items;
    expect(row).toMatchObject({ accountName: MANUAL_ACCOUNT_NAME, merchant: "" });
    expect((await overview(db)).find((c) => c.currency === "USD")).toMatchObject({ incomeMinor: 0, incomeNotCountedMinor: 4500 });
  });

  it("refuses an expense category, another currency than the account's, and an account that is not mine", async () => {
    const { db, checking } = await setup();
    const salary = await catId(db, "工资");
    const base = { amountMinor: 100, currency: "USD", categoryId: salary, date: "2026-09-15", accountId: checking, note: null };
    await expect(createIncomeEntry(db, user, { ...base, categoryId: await catId(db, "餐饮") })).rejects.toMatchObject({ code: "category_not_for_income" });
    await expect(createIncomeEntry(db, user, { ...base, currency: "CNY" })).rejects.toMatchObject({ code: "quick_currency_mismatch", params: { currency: "USD" } });
    await expect(createIncomeEntry(db, user, { ...base, accountId: 9999 })).rejects.toMatchObject({ code: "quick_account_not_found" });
    await expect(createIncomeEntry(db, user, { ...base, amountMinor: 0 })).rejects.toMatchObject({ code: "amount_not_positive" });
  });

  it("a transfer writes two linked legs that count as neither spending nor income", async () => {
    const { db, checking, savings } = await setup();
    const { transactionIds } = await createTransferEntry(db, user, { fromAccountId: checking, toAccountId: savings, amountMinor: 50000, date: "2026-09-12" });
    const rows = (await listTransactions(db, user)).items;
    const out = rows.find((r) => r.id === transactionIds[0])!;
    const into = rows.find((r) => r.id === transactionIds[1])!;
    expect(out).toMatchObject({ kind: "transfer", amountMinor: -50000, currency: "USD", accountName: "Checking 3141", transferAccountName: "Savings 5501", myShareMinor: 0 });
    expect(into).toMatchObject({ kind: "transfer", amountMinor: 50000, accountName: "Savings 5501", transferAccountName: "Checking 3141" });
    expect(await overview(db)).toEqual([]);
  });

  it("refuses a transfer within one account or across currencies", async () => {
    const { db, checking, alipay } = await setup();
    const base = { fromAccountId: checking, toAccountId: checking, amountMinor: 100, date: "2026-09-12" };
    await expect(createTransferEntry(db, user, base)).rejects.toMatchObject({ code: "quick_transfer_same_account" });
    await expect(createTransferEntry(db, user, { ...base, toAccountId: alipay })).rejects.toMatchObject({ code: "quick_transfer_currency_mismatch", params: { from: "USD", to: "CNY" } });
    expect((await listTransactions(db, user)).items).toEqual([]);
  });
});
