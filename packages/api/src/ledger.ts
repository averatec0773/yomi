import {
  type ApiError,
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
  LedgerError,
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
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const LEDGER_ERROR_STATUS: Record<LedgerError["kind"], ContentfulStatusCode> = {
  not_found: 404,
  category_not_found: 422,
  category_kind_mismatch: 422,
  system_category: 403,
  duplicate_name: 409,
  invalid_input: 400,
  split_conflict: 409,
};

export function ledgerErrorHandler(err: Error, c: Context): Response {
  if (err instanceof LedgerError) {
    return c.json({ error: err.message, code: err.code, params: err.params } satisfies ApiError, LEDGER_ERROR_STATUS[err.kind]);
  }
  throw err;
}

/** The part of a zod schema this module uses (zod itself is not an api dependency). */
interface Schema<T> {
  safeParse(
    v: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

/** Validates a JSON body (or any value) against a schema; a 400 response on failure. */
export async function parseJson<T>(c: Context, schema: Schema<T>, value?: unknown): Promise<Parsed<T>> {
  let input = value;
  if (value === undefined) {
    try {
      input = await c.req.json();
    } catch {
      return { ok: false, res: c.json({ error: "The request body is not valid JSON", code: "invalid_json" } satisfies ApiError, 400) };
    }
  }
  const r = schema.safeParse(input);
  if (!r.success) {
    const details = r.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; ");
    return { ok: false, res: c.json({ error: `Invalid request: ${details}`, code: "validation_failed", params: { details } } satisfies ApiError, 400) };
  }
  return { ok: true, data: r.data };
}

export function idParam(c: Context): number | null {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

const badId = (c: Context) => c.json({ error: "Invalid id", code: "invalid_id", params: { name: "id" } } satisfies ApiError, 400);

/** Routes: /transactions, /categories, /months, /ledger/recategorize (mounted under /api). */
export function ledgerRoutes(deps: { getDb: () => Db | Promise<Db> }): Hono {
  const r = new Hono();
  r.onError(ledgerErrorHandler);

  r.get("/transactions", async (c) => {
    const q = await parseJson(c, TransactionQuery, c.req.query());
    if (!q.ok) return q.res;
    const db = await deps.getDb();
    const user = getCurrentUser();
    const page = await listTransactions(db, user, q.data);
    const { month, from, to } = q.data;
    const body: TransactionPage =
      from !== undefined && to !== undefined
        ? { ...page, totals: await rangeTotalsForList(db, user, from, to) }
        : month
          ? { ...page, totals: await monthTotalsForList(db, user, month) }
          : page;
    return c.json(body);
  });

  r.post("/transactions/bulk", async (c) => {
    const b = await parseJson(c, BulkUpdateInput);
    if (!b.ok) return b.res;
    const { ids, ...patch } = b.data;
    return c.json((await bulkUpdate(await deps.getDb(), getCurrentUser(), ids, patch)) satisfies BulkUpdateResult);
  });

  r.patch("/transactions/:id", async (c) => {
    const id = idParam(c);
    if (id == null) return badId(c);
    const b = await parseJson(c, TransactionPatch);
    if (!b.ok) return b.res;
    return c.json((await updateTransaction(await deps.getDb(), getCurrentUser(), id, b.data)) satisfies TransactionItem);
  });

  r.post("/transactions/:id/category", async (c) => {
    const id = idParam(c);
    if (id == null) return badId(c);
    const b = await parseJson(c, SetCategoryInput);
    if (!b.ok) return b.res;
    const out = await setCategory(await deps.getDb(), getCurrentUser(), id, b.data.categoryId, { applyToMerchant: b.data.applyToMerchant });
    return c.json(out satisfies SetCategoryResult);
  });

  r.get("/categories", async (c) => c.json({ categories: await listCategories(await deps.getDb(), getCurrentUser()) } satisfies CategoryList));

  r.post("/categories", async (c) => {
    const b = await parseJson(c, CreateCategoryInput);
    if (!b.ok) return b.res;
    return c.json((await createCategory(await deps.getDb(), getCurrentUser(), b.data.name, b.data.kind)) satisfies Category, 201);
  });

  r.patch("/categories/:id", async (c) => {
    const id = idParam(c);
    if (id == null) return badId(c);
    const b = await parseJson(c, UpdateCategoryInput);
    if (!b.ok) return b.res;
    const db = await deps.getDb();
    const user = getCurrentUser();
    let out: Category | undefined;
    if (b.data.name !== undefined) out = await renameCategory(db, user, id, b.data.name);
    if (b.data.archived !== undefined) out = await archiveCategory(db, user, id, b.data.archived);
    return c.json(out! satisfies Category);
  });

  r.get("/months", async (c) => c.json({ months: await listMonths(await deps.getDb(), getCurrentUser()) } satisfies MonthList));

  r.post("/ledger/recategorize", async (c) =>
    c.json((await recategorizeUnedited(await deps.getDb(), getCurrentUser())) satisfies RecategorizeResult),
  );

  return r;
}
