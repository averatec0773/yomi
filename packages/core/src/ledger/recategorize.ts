import { categories, type Db, merchantRules, transactions } from "@yomi/db";
import { and, eq } from "@yomi/db/orm";
import { resolveCategoryId } from "../import/categorize";
import { cleanMerchant } from "../import/merchant";
import type { CurrentUser } from "../user";

export interface RecategorizeResult {
  /** Imported rows the user has not edited. */
  scanned: number;
  categoryChanged: number;
  merchantChanged: number;
  /** ICBC rebate/cashback rows imported as refunds before the importer booked them as income. */
  kindChanged: number;
}

const REBATE = /REBATE|CASH\s?BACK/i;

/**
 * Re-runs merchant cleanup and default categorization (merchant rule → keywords → refund
 * inheritance → source category → fallback) on imported rows the user has not edited. Edited rows are
 * never touched but still lend their category to refunds of the same merchant. ICBC rebate rows
 * stored as refunds are rebooked as income (the importer now does this at parse time).
 */
export async function recategorizeUnedited(db: Db, user: CurrentUser): Promise<RecategorizeResult> {
  const userId = user.id;
  return await db.transaction(async (tx) => {
    const cats = await tx.select().from(categories).where(eq(categories.userId, userId));
    const idByName = new Map(cats.map((c) => [c.name, c.id]));
    const kindById = new Map(cats.map((c) => [c.id, c.kind]));
    const rules = new Map(
      (await tx
        .select({ merchant: merchantRules.merchant, categoryId: merchantRules.categoryId })
        .from(merchantRules)
        .where(eq(merchantRules.userId, userId))
        )
        .map((r) => [r.merchant, r.categoryId]),
    );
    const rows = (await tx
      .select({
        id: transactions.id,
        occurredAt: transactions.occurredAt,
        kind: transactions.kind,
        source: transactions.source,
        sourceCategory: transactions.sourceCategory,
        counterparty: transactions.counterpartyRaw,
        description: transactions.descriptionRaw,
        merchant: transactions.merchant,
        categoryId: transactions.categoryId,
        userEditedAt: transactions.userEditedAt,
      })
      .from(transactions)
      .where(eq(transactions.userId, userId))
      )
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : b.id - a.id));

    const next = new Map<number, { merchant: string; categoryId: number | null }>();
    for (const r of rows) {
      // Manual rows have no imported counterparty to re-clean; keep what quick entry stored.
      const reclean = r.userEditedAt == null && r.source !== "manual" && r.counterparty.trim() !== "";
      next.set(r.id, { merchant: reclean ? cleanMerchant(r.counterparty) : r.merchant, categoryId: r.categoryId });
    }
    // Latest purchase category per merchant, filled as purchases are resolved (newest first).
    const purchaseCategory = new Map<string, number>();
    const ctx = {
      idByName,
      kindById,
      ruleCategoryId: (m: string) => rules.get(m) ?? null,
      inheritedCategoryId: (m: string) => purchaseCategory.get(m) ?? null,
    };
    // Manual rows were categorized at entry time; only imported rows are re-derived.
    const unedited = rows.filter((r) => r.userEditedAt == null && r.source !== "manual");
    const kindFixed = new Set<number>();
    for (const r of unedited) {
      if (r.source === "icbc_pdf" && r.kind === "refund" && REBATE.test(r.counterparty)) {
        r.kind = "income";
        kindFixed.add(r.id);
      }
    }
    for (const r of unedited) {
      if (r.kind === "refund") continue;
      next.get(r.id)!.categoryId = resolveCategoryId(r, next.get(r.id)!.merchant, ctx);
    }
    for (const r of rows) {
      if (r.kind !== "expense") continue;
      const n = next.get(r.id)!;
      if (n.merchant && n.categoryId != null && !purchaseCategory.has(n.merchant)) purchaseCategory.set(n.merchant, n.categoryId);
    }
    for (const r of unedited) {
      if (r.kind === "refund") next.get(r.id)!.categoryId = resolveCategoryId(r, next.get(r.id)!.merchant, ctx);
    }

    let categoryChanged = 0;
    let merchantChanged = 0;
    for (const r of unedited) {
      const n = next.get(r.id)!;
      const catDiff = n.categoryId !== r.categoryId;
      const merDiff = n.merchant !== r.merchant;
      const kindDiff = kindFixed.has(r.id);
      if (!catDiff && !merDiff && !kindDiff) continue;
      if (catDiff) categoryChanged++;
      if (merDiff) merchantChanged++;
      await tx.update(transactions)
        .set({ categoryId: n.categoryId, merchant: n.merchant, kind: r.kind, updatedAt: new Date().toISOString() })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, r.id)));
    }
    return { scanned: unedited.length, categoryChanged, merchantChanged, kindChanged: kindFixed.size };
  });
}
