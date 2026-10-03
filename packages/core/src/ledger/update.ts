import { categories, type Db, merchantRules, transactions, transactionSplits } from "@yomi/db";
import { and, asc, eq, inArray, isNull, max, ne } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { LedgerError } from "./errors";
import { getTransaction, type TransactionItem, type TransactionKind } from "./transactions";

export interface TransactionPatch {
  categoryId?: number | null;
  kind?: TransactionKind;
  note?: string | null;
  merchant?: string;
}

export interface CategoryItem {
  id: number;
  name: string;
  kind: "expense" | "income";
  isSystem: boolean;
  sort: number;
  archivedAt: string | null;
}

const now = () => new Date().toISOString();

async function categoryOf(db: Db, userId: number, id: number) {
  const c = (await db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .limit(1))[0];
  if (!c) throw new LedgerError("invalid", "category_not_found", `Category #${id} does not exist`, { id });
  return c;
}

/** Expense rows take expense categories, income rows income ones; refunds and transfers take either. */
function fits(rowKind: TransactionKind, catKind: "expense" | "income"): boolean {
  if (rowKind === "expense") return catKind === "expense";
  if (rowKind === "income") return catKind === "income";
  return true;
}

function kindsFor(catKind: "expense" | "income"): TransactionKind[] {
  return catKind === "expense" ? ["expense", "refund"] : ["income", "refund"];
}

const SPLITTABLE: ReadonlySet<TransactionKind> = new Set(["expense", "refund"]);
/** The category belongs to the other side (income vs expense). */
function categoryKindMismatch(name: string, kind: string): LedgerError {
  return kind === "income"
    ? new LedgerError("invalid", "category_not_for_income", `Category "${name}" is not an income category`, { name })
    : new LedgerError("invalid", "category_not_for_expense", `Category "${name}" is not an expense category`, { name });
}

export const SPLIT_KIND_MESSAGE = "This row is split; remove the split before changing its type";

async function hasSplits(db: Db, userId: number, id: number): Promise<boolean> {
  return (
    (await db
      .select({ id: transactionSplits.id })
      .from(transactionSplits)
      .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.transactionId, id)))
      .limit(1))[0] !== undefined
  );
}

/** Splits only live on expense/refund rows; moving a split row to another kind would desync AA and spending. */
async function blocksKindChange(db: Db, userId: number, from: TransactionKind, to: TransactionKind, id: number): Promise<boolean> {
  return from !== to && !SPLITTABLE.has(to) && await hasSplits(db, userId, id);
}

async function rowOf(db: Db, userId: number, id: number) {
  const r = (await db
    .select({ id: transactions.id, kind: transactions.kind, merchant: transactions.merchant, categoryId: transactions.categoryId })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .limit(1))[0];
  if (!r) throw new LedgerError("not_found", "transaction_not_found", `Transaction #${id} does not exist`, { id });
  return r;
}

/** Edits one row and marks it user-edited (so re-categorization and batch revert leave it alone). */
export async function updateTransaction(db: Db, user: CurrentUser, id: number, patch: TransactionPatch): Promise<TransactionItem> {
  const userId = user.id;
  const row = await rowOf(db, userId, id);
  const kind = patch.kind ?? row.kind;
  if (patch.kind !== undefined && await blocksKindChange(db, userId, row.kind, patch.kind, id)) {
    throw new LedgerError("conflict", "ledger_kind_change_on_split", SPLIT_KIND_MESSAGE);
  }
  let categoryId = patch.categoryId !== undefined ? patch.categoryId : row.categoryId;
  if (patch.categoryId != null) {
    const cat = await categoryOf(db, userId, patch.categoryId);
    if (!fits(kind, cat.kind)) {
      throw categoryKindMismatch(cat.name, kind);
    }
  } else if (patch.kind !== undefined && categoryId != null && !fits(kind, (await categoryOf(db, userId, categoryId)).kind)) {
    // Kind changed and the old category no longer fits: drop it rather than keep a wrong one.
    categoryId = null;
  }
  const set: Partial<typeof transactions.$inferInsert> = { userEditedAt: now(), updatedAt: now(), categoryId };
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.note !== undefined) set.note = patch.note?.trim() ? patch.note.trim() : null;
  if (patch.merchant !== undefined) {
    const m = patch.merchant.trim();
    if (!m) throw new LedgerError("invalid", "merchant_empty", "The merchant cannot be empty");
    set.merchant = m;
  }
  await db.update(transactions)
    .set(set)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
  return await getTransaction(db, user, id);
}

/**
 * Sets the row's category. With applyToMerchant, also records the merchant rule and applies the
 * category to other rows of the same merchant that the user has not edited (and whose kind fits).
 * Returns the number of rows changed, this one included.
 */
export async function setCategory(
  db: Db,
  user: CurrentUser,
  id: number,
  categoryId: number,
  opts: { applyToMerchant: boolean },
): Promise<{ affected: number }> {
  const userId = user.id;
  return await db.transaction(async (tx) => {
    const row = await rowOf(tx, userId, id);
    const cat = await categoryOf(tx, userId, categoryId);
    if (!fits(row.kind, cat.kind)) {
      throw categoryKindMismatch(cat.name, row.kind);
    }
    await tx.update(transactions)
      .set({ categoryId, userEditedAt: now(), updatedAt: now() })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
    let others = 0;
    if (opts.applyToMerchant && row.merchant) {
      await tx.insert(merchantRules)
        .values({ userId, merchant: row.merchant, categoryId })
        .onConflictDoUpdate({ target: [merchantRules.userId, merchantRules.merchant], set: { categoryId, updatedAt: now() } });
      others = (await tx
        .update(transactions)
        .set({ categoryId, updatedAt: now() })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.merchant, row.merchant),
            ne(transactions.id, id),
            isNull(transactions.userEditedAt),
            inArray(transactions.kind, kindsFor(cat.kind)),
          ),
        )
        .returning({ id: transactions.id })
        ).length;
    }
    return { affected: 1 + others };
  });
}

/**
 * Applies a category or a kind to many rows. A category skips rows whose kind it does not fit; a kind
 * alone drops categories that no longer fit; a kind change away from expense/refund skips split rows
 * (counted in skippedSplit).
 */
export async function bulkUpdate(
  db: Db,
  user: CurrentUser,
  ids: readonly number[],
  patch: { categoryId?: number | null; kind?: TransactionKind },
): Promise<{ updated: number; skippedSplit: number }> {
  const userId = user.id;
  if (ids.length === 0) return { updated: 0, skippedSplit: 0 };
  if (patch.categoryId === undefined && patch.kind === undefined) {
    throw new LedgerError("invalid", "recategorize_needs_target", "categoryId or kind is required");
  }
  return await db.transaction(async (tx) => {
    const cat = patch.categoryId != null ? await categoryOf(tx, userId, patch.categoryId) : null;
    if (cat && patch.kind !== undefined && !fits(patch.kind, cat.kind)) {
      throw new LedgerError("invalid", "category_kind_mismatch", `Category "${cat.name}" does not fit`, { name: cat.name });
    }
    const catKinds = new Map<number, "expense" | "income">();
    const kindOfCategory = async (id: number) => {
      if (!catKinds.has(id)) catKinds.set(id, (await categoryOf(tx, userId, id)).kind);
      return catKinds.get(id)!;
    };
    let updated = 0;
    let skippedSplit = 0;
    const rows: { id: number; kind: TransactionKind; categoryId: number | null }[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      rows.push(
        ...await tx
          .select({ id: transactions.id, kind: transactions.kind, categoryId: transactions.categoryId })
          .from(transactions)
          .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids.slice(i, i + 500))))
          ,
      );
    }
    for (const row of rows) {
      if (patch.kind !== undefined && await blocksKindChange(tx, userId, row.kind, patch.kind, row.id)) {
        skippedSplit += 1;
        continue;
      }
      const kind = patch.kind ?? row.kind;
      if (cat && patch.kind === undefined && !fits(row.kind, cat.kind)) continue;
      const set: Partial<typeof transactions.$inferInsert> = { userEditedAt: now(), updatedAt: now() };
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.categoryId !== undefined) set.categoryId = patch.categoryId;
      else if (row.categoryId != null && !fits(kind, await kindOfCategory(row.categoryId))) set.categoryId = null;
      await tx.update(transactions)
        .set(set)
        .where(and(eq(transactions.userId, userId), eq(transactions.id, row.id)));
      updated += 1;
    }
    return { updated, skippedSplit };
  });
}

export async function listCategories(db: Db, user: CurrentUser): Promise<CategoryItem[]> {
  return await db
    .select({
      id: categories.id,
      name: categories.name,
      kind: categories.kind,
      isSystem: categories.isSystem,
      sort: categories.sort,
      archivedAt: categories.archivedAt,
    })
    .from(categories)
    .where(eq(categories.userId, user.id))
    .orderBy(asc(categories.kind), asc(categories.sort), asc(categories.id));
}

async function assertNameFree(db: Db, userId: number, name: string, exceptId?: number) {
  const hit = (await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.name, name)))
    .limit(1))[0];
  if (hit && hit.id !== exceptId) throw new LedgerError("conflict", "category_name_taken", `Category "${name}" already exists`, { name });
}

function cleanName(name: string): string {
  const n = name.trim();
  if (!n) throw new LedgerError("invalid", "category_name_empty", "The category name cannot be empty");
  return n;
}

export async function createCategory(db: Db, user: CurrentUser, name: string, kind: "expense" | "income"): Promise<CategoryItem> {
  const userId = user.id;
  const n = cleanName(name);
  await assertNameFree(db, userId, n);
  const top = (await db
    .select({ s: max(categories.sort) })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.kind, kind)))
    .limit(1))[0];
  return (await db
    .insert(categories)
    .values({ userId, name: n, kind, isSystem: false, sort: (top?.s ?? -1) + 1 })
    .returning({
      id: categories.id,
      name: categories.name,
      kind: categories.kind,
      isSystem: categories.isSystem,
      sort: categories.sort,
      archivedAt: categories.archivedAt,
    })
    )[0]!;
}

async function userCategory(db: Db, userId: number, id: number) {
  const c = await categoryOf(db, userId, id);
  if (c.isSystem) throw new LedgerError("forbidden", "category_system_locked", `System category "${c.name}" cannot be changed`, { name: c.name });
  return c;
}

export async function renameCategory(db: Db, user: CurrentUser, id: number, name: string): Promise<CategoryItem> {
  await userCategory(db, user.id, id);
  const n = cleanName(name);
  await assertNameFree(db, user.id, n, id);
  await db.update(categories)
    .set({ name: n })
    .where(and(eq(categories.userId, user.id), eq(categories.id, id)));
  return (await listCategories(db, user)).find((c) => c.id === id)!;
}

/** Archived categories stay on existing rows; the UI stops offering them. */
export async function archiveCategory(db: Db, user: CurrentUser, id: number, archived = true): Promise<CategoryItem> {
  await userCategory(db, user.id, id);
  await db.update(categories)
    .set({ archivedAt: archived ? now() : null })
    .where(and(eq(categories.userId, user.id), eq(categories.id, id)));
  return (await listCategories(db, user)).find((c) => c.id === id)!;
}
