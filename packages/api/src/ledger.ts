import {
  BulkUpdateInput,
  type BulkUpdateResult,
  type Category,
  type CategoryList,
  CreateCategoryInput,
  type MonthList,
  type RecategorizeResult,
  SetCategoryInput,
  type SetCategoryResult,
  type TransactionItem,
  type TransactionPage,
  TransactionPatch,
  TransactionQuery,
  UpdateCategoryInput,
} from "@yomi/contracts";
import {
  archiveCategory,
  bulkUpdate,
  createCategory,
  getCurrentUser,
  listCategories,
  listMonths,
  listTransactions,
  monthTotalsForList,
  rangeTotalsForList,
  recategorizeUnedited,
  renameCategory,
  setCategory,
  updateTransaction,
} from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { idParam, readJson, readQuery } from "./http";

/** Routes: /transactions, /categories, /months, /ledger/recategorize (mounted under /api). */
export function ledgerRoutes(deps: { getDb: () => Db | Promise<Db> }): Hono {
  const r = new Hono();

  r.get("/transactions", async (c) => {
    const q = readQuery(c, TransactionQuery);
    const db = await deps.getDb();
    const user = getCurrentUser();
    const page = await listTransactions(db, user, q);
    const { month, from, to } = q;
    const body: TransactionPage =
      from !== undefined && to !== undefined
        ? { ...page, totals: await rangeTotalsForList(db, user, from, to) }
        : month
          ? { ...page, totals: await monthTotalsForList(db, user, month) }
          : page;
    return c.json(body);
  });

  r.post("/transactions/bulk", async (c) => {
    const { ids, ...patch } = await readJson(c, BulkUpdateInput);
    return c.json((await bulkUpdate(await deps.getDb(), getCurrentUser(), ids, patch)) satisfies BulkUpdateResult);
  });

  r.patch("/transactions/:id", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, TransactionPatch);
    return c.json((await updateTransaction(await deps.getDb(), getCurrentUser(), id, body)) satisfies TransactionItem);
  });

  r.post("/transactions/:id/category", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, SetCategoryInput);
    const out = await setCategory(await deps.getDb(), getCurrentUser(), id, body.categoryId, { applyToMerchant: body.applyToMerchant });
    return c.json(out satisfies SetCategoryResult);
  });

  r.get("/categories", async (c) => c.json({ categories: await listCategories(await deps.getDb(), getCurrentUser()) } satisfies CategoryList));

  r.post("/categories", async (c) => {
    const body = await readJson(c, CreateCategoryInput);
    return c.json((await createCategory(await deps.getDb(), getCurrentUser(), body.name, body.kind)) satisfies Category, 201);
  });

  r.patch("/categories/:id", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, UpdateCategoryInput);
    const db = await deps.getDb();
    const user = getCurrentUser();
    let out: Category | undefined;
    if (body.name !== undefined) out = await renameCategory(db, user, id, body.name);
    if (body.archived !== undefined) out = await archiveCategory(db, user, id, body.archived);
    return c.json(out! satisfies Category);
  });

  r.get("/months", async (c) => c.json({ months: await listMonths(await deps.getDb(), getCurrentUser()) } satisfies MonthList));

  r.post("/ledger/recategorize", async (c) =>
    c.json((await recategorizeUnedited(await deps.getDb(), getCurrentUser())) satisfies RecategorizeResult),
  );

  return r;
}
