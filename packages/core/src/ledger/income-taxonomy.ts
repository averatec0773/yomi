import { categories, type Db, settlements, transactions, transactionSplits } from "@yomi/db";
import { and, eq, isNotNull } from "@yomi/db/orm";
import { resolveCategoryId } from "../import/categorize";
import { categoryContext, latestPurchaseCategories, loadCategorySources } from "../import/category-context";
import { readSetting, writeSetting } from "../settings/store";
import type { CurrentUser } from "../user";
import { ensureSystemCategories } from "./system-categories";

/** user_settings marker: the income upgrade ran for this user; later starts skip it. */
const MARKER = "income_taxonomy";

export interface IncomeUpgradeResult {
  /** Legacy income categories (退款 refunds, 转入 transfers in) archived now. */
  archived: number;
  /** Unedited rows on 退款 that became refunds, their category taken from the purchase. */
  refundsRebooked: number;
  /** Unedited rows on 转入 re-categorized by the current importer rules (their kind kept). */
  transfersInRecategorized: number;
  /** Edited rows on 退款 or 转入 moved to Other income (their kind kept). */
  editedMoved: number;
  /** Other unedited income rows whose category changed (cashback, interest, salary, ...). */
  incomeRecategorized: number;
  /** Rows on the legacy categories, or income rows, left alone: split, settled, closed or a linked duplicate. */
  skippedLocked: number;
}

/**
 * The one-time move to the income taxonomy (keyed categories, refund and transfer as kinds only). Keys the system
 * categories and inserts the new income ones, archives 退款 and 转入 (never deletes them), then re-files rows:
 * unedited rows on 退款 become refunds; unedited rows on 转入 and other unedited income rows are re-categorized by the
 * importer rules (Zelle and wires in → Other income, rewards → Cashback, interest → Interest, Plaid INCOME_* by detail);
 * edited rows on 退款 or 转入 keep their kind and move to Other income. Rows with a split or settlement, closed rows and
 * linked duplicates are never touched, and no row changes kind except a refund booked as income (own-account transfers
 * are proposed for review, never applied here). Every step only sets what is not set yet, so running it again changes
 * nothing; the marker only saves the work on later starts. Null when the marker says it ran.
 */
export async function upgradeIncomeTaxonomy(db: Db, user: CurrentUser): Promise<IncomeUpgradeResult | null> {
  if ((await readSetting(db, user, MARKER)) !== null) return null;
  return await db.transaction(async (tx) => {
    const result = await migrateRows(tx, user);
    await writeSetting(tx, user, MARKER, "1");
    return result;
  });
}

async function migrateRows(tx: Db, user: CurrentUser): Promise<IncomeUpgradeResult> {
  const userId = user.id;
  await ensureSystemCategories(tx, userId);
  const cats = await tx.select().from(categories).where(eq(categories.userId, userId));
  const byKey = new Map(cats.flatMap((c) => (c.key ? [[c.key, c] as const] : [])));
  const refunds = byKey.get("refunds");
  const transfersIn = byKey.get("transfersIn");
  const legacy = new Set([refunds?.id, transfersIn?.id].filter((id): id is number => id != null));
  const now = new Date().toISOString();

  let archived = 0;
  for (const c of [refunds, transfersIn]) {
    if (!c || c.archivedAt != null) continue;
    await tx.update(categories).set({ archivedAt: now }).where(eq(categories.id, c.id));
    archived += 1;
  }

  const rows = await tx
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      kind: transactions.kind,
      status: transactions.status,
      duplicateOfId: transactions.duplicateOfId,
      source: transactions.source,
      sourceCategory: transactions.sourceCategory,
      counterparty: transactions.counterpartyRaw,
      description: transactions.descriptionRaw,
      merchant: transactions.merchant,
      categoryId: transactions.categoryId,
      userEditedAt: transactions.userEditedAt,
    })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  const locked = new Set([
    ...(await tx.select({ id: transactionSplits.transactionId }).from(transactionSplits).where(eq(transactionSplits.userId, userId))).map((r) => r.id),
    ...(await tx
      .select({ id: settlements.transactionId })
      .from(settlements)
      .where(and(eq(settlements.userId, userId), isNotNull(settlements.transactionId)))).map((r) => r.id!),
  ]);

  const onLegacy = (r: (typeof rows)[number]) => r.categoryId != null && legacy.has(r.categoryId);
  const inScope = rows.filter((r) => onLegacy(r) || (r.kind === "income" && r.userEditedAt == null && r.source !== "manual"));
  const movable = inScope.filter((r) => !locked.has(r.id) && r.status === "ok" && r.duplicateOfId == null);

  const sources = await loadCategorySources(tx, user);
  const inherited = await latestPurchaseCategories(
    tx,
    user,
    movable.filter((r) => r.categoryId === refunds?.id && r.userEditedAt == null).map((r) => r.merchant),
  );
  const ctx = categoryContext(sources, (m) => inherited.get(m) ?? null);
  const fallback = (kind: (typeof rows)[number]["kind"]) => (kind === "expense" ? byKey.get("other")?.id : kind === "transfer" ? null : byKey.get("otherIncome")?.id) ?? null;

  const out: IncomeUpgradeResult = { archived, refundsRebooked: 0, transfersInRecategorized: 0, editedMoved: 0, incomeRecategorized: 0, skippedLocked: inScope.length - movable.length };
  for (const r of movable) {
    let next: { kind: typeof r.kind; categoryId: number | null };
    if (onLegacy(r) && r.userEditedAt != null) {
      next = { kind: r.kind, categoryId: fallback(r.kind) };
      out.editedMoved += 1;
    } else if (r.categoryId === refunds?.id) {
      next = { kind: "refund", categoryId: resolveCategoryId({ ...r, kind: "refund" }, r.merchant, ctx) };
      out.refundsRebooked += 1;
    } else {
      const categoryId = resolveCategoryId(r, r.merchant, ctx);
      if (categoryId === r.categoryId) continue;
      next = { kind: r.kind, categoryId };
      if (onLegacy(r)) out.transfersInRecategorized += 1;
      else out.incomeRecategorized += 1;
    }
    await tx
      .update(transactions)
      .set({ ...next, updatedAt: now })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, r.id)));
  }
  return out;
}
