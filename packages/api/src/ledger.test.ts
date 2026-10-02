import {
  ApiError,
  BulkUpdateResult,
  Category,
  CategoryList,
  MonthList,
  MonthOverview,
  RecategorizeResult,
  SetCategoryResult,
  Target,
  TransactionItem,
  TransactionPage,
} from "@yomi/contracts";
import { getCurrentUser, listCategories, seed } from "@yomi/core";
import { transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

async function setup() {
  const db = await testDb();
  await seed(db);
  const userId = getCurrentUser().id;
  const cat = async (name: string) => (await listCategories(db, getCurrentUser())).find((x) => x.name === name)!.id;
  const add = async (p: Partial<typeof transactions.$inferInsert> & { amountMinor: number; dedupKey: string }) =>
    (
      await db
        .insert(transactions)
        .values({
          userId,
          occurredAt: "2026-09-10T12:00:00+08:00",
          currency: "CNY",
          kind: p.amountMinor < 0 ? "expense" : "income",
          source: "icbc_pdf",
          ...p,
        })
        .returning({ id: transactions.id })
    )[0]!.id;
  const a = await add({ amountMinor: -3000, dedupKey: "a", counterpartyRaw: "Nintendo CC1610834036", merchant: "Nintendo CC1610834036", categoryId: await cat("其他") });
  const b = await add({ amountMinor: -5000, dedupKey: "b", counterpartyRaw: "BLIZZARD", merchant: "Blizzard", categoryId: await cat("其他") });
  const c = await add({ amountMinor: -700, dedupKey: "c", counterpartyRaw: "BLIZZARD", merchant: "Blizzard", categoryId: await cat("其他"), occurredAt: "2026-08-01T12:00:00+08:00" });
  return { app: createApi({ getDb: () => db }), cat, a, b, c };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("ledger api", () => {
  it("lists, filters and totals transactions", async () => {
    const { app, a, b, c } = await setup();
    const all = TransactionPage.parse(await (await app.request("/api/transactions")).json());
    expect(all.items.map((t) => t.id)).toEqual([b, a, c]);
    expect(all.totals).toBeUndefined();
    const sep = TransactionPage.parse(await (await app.request("/api/transactions?month=2026-09&q=bliz")).json());
    expect(sep.items.map((t) => t.id)).toEqual([b]);
    expect(sep.totals).toMatchObject([{ currency: "CNY", count: 2, spendingMinor: 8000 }]);
    const unc = TransactionPage.parse(await (await app.request("/api/transactions?uncategorized=true&limit=2")).json());
    expect(unc).toMatchObject({ total: 3 });
    expect(unc.items).toHaveLength(2);
    const bad = await app.request("/api/transactions?month=2026-9");
    expect(bad.status).toBe(400);
    expect(ApiError.parse(await bad.json()).code).toBe("validation_failed");
    expect(MonthList.parse(await (await app.request("/api/months")).json()).months).toEqual([
      { month: "2026-09", count: 2 },
      { month: "2026-08", count: 1 },
    ]);
  });

  it("patches, sets categories by merchant and bulk-updates", async () => {
    const { app, cat, a, b, c } = await setup();
    const patched = await app.request(`/api/transactions/${a}`, json("PATCH", { note: "switch game", kind: "expense" }));
    expect(patched.status).toBe(200);
    expect(TransactionItem.parse(await patched.json())).toMatchObject({ note: "switch game" });
    expect((await app.request(`/api/transactions/${a}`, json("PATCH", { bogus: 1 }))).status).toBe(400);
    expect((await app.request(`/api/transactions/999`, json("PATCH", { note: "x" }))).status).toBe(404);
    expect((await app.request(`/api/transactions/${a}`, json("PATCH", { categoryId: await cat("工资") }))).status).toBe(422);

    const set = await app.request(`/api/transactions/${b}/category`, json("POST", { categoryId: await cat("娱乐"), applyToMerchant: true }));
    expect(SetCategoryResult.parse(await set.json())).toEqual({ affected: 2 });

    const bulk = await app.request("/api/transactions/bulk", json("POST", { ids: [a, b, c], kind: "transfer" }));
    expect(BulkUpdateResult.parse(await bulk.json())).toEqual({ updated: 3, skippedSplit: 0 });
    expect((await app.request("/api/transactions/bulk", json("POST", { ids: [a] }))).status).toBe(400);
  });

  it("manages categories", async () => {
    const { app, cat } = await setup();
    const created = await app.request("/api/categories", json("POST", { name: "宠物", kind: "expense" }));
    expect(created.status).toBe(201);
    const pet = Category.parse(await created.json());
    expect((await app.request("/api/categories", json("POST", { name: "宠物", kind: "expense" }))).status).toBe(409);
    const renamed = await app.request(`/api/categories/${pet.id}`, json("PATCH", { name: "猫", archived: true }));
    expect(Category.parse(await renamed.json())).toMatchObject({ name: "猫" });
    expect((await app.request(`/api/categories/${await cat("餐饮")}`, json("PATCH", { name: "吃" }))).status).toBe(403);
    const list = CategoryList.parse(await (await app.request("/api/categories")).json());
    expect(list.categories.find((x) => x.id === pet.id)?.archivedAt).not.toBeNull();
  });

  it("month overview, targets and recategorize", async () => {
    const { app } = await setup();
    const t = await app.request("/api/targets", json("PUT", { month: null, amountMinor: 100000, currency: "CNY" }));
    expect(Target.parse(await t.json())).toMatchObject({ month: null, amountMinor: 100000 });
    expect((await app.request("/api/targets", json("PUT", { month: null, amountMinor: -1, currency: "CNY" }))).status).toBe(400);

    const o = MonthOverview.parse(await (await app.request("/api/month/2026-09")).json());
    expect(o.currencies[0]).toMatchObject({ currency: "CNY", spendingMinor: 8000, previousMonthSpendingMinor: 700 });
    expect(o.currencies[0]!.target).toMatchObject({ remainingMinor: 92000 });
    expect((await app.request("/api/month/2026-13")).status).toBe(400);

    const rec = await app.request("/api/ledger/recategorize", { method: "POST" });
    expect(RecategorizeResult.parse(await rec.json())).toEqual({ scanned: 3, categoryChanged: 3, merchantChanged: 1, kindChanged: 0 });
    const items = TransactionPage.parse(await (await app.request("/api/transactions?month=2026-09")).json()).items;
    expect(items.map((i) => [i.merchant, i.categoryName])).toEqual([
      ["Blizzard", "娱乐"],
      ["Nintendo", "娱乐"],
    ]);
  });
});
