import { categories, type Db, merchantRules, transactions } from "@yomi/db";
import { and, desc, eq, isNotNull } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import type { CategoryContext } from "./categorize";

export type MerchantRuleRow = typeof merchantRules.$inferSelect;

/** What categorizing a new row reads from the ledger: the user's categories and merchant rules. */
export interface CategorySources {
  idByName: ReadonlyMap<string, number>;
  kindById: ReadonlyMap<number, "expense" | "income">;
  rules: ReadonlyMap<string, MerchantRuleRow>;
}

export async function loadCategorySources(q: Db, user: CurrentUser): Promise<CategorySources> {
  const cats = await q.select().from(categories).where(eq(categories.userId, user.id));
  const rules = await q.select().from(merchantRules).where(eq(merchantRules.userId, user.id));
  return {
    idByName: new Map(cats.map((c) => [c.name, c.id])),
    kindById: new Map(cats.map((c) => [c.id, c.kind])),
    rules: new Map(rules.map((r) => [r.merchant, r])),
  };
}

/** resolveCategoryId's context: merchant rules from `sources`, a refund's purchase category from `inherited`. */
export function categoryContext(sources: CategorySources, inherited: (merchant: string) => number | null): CategoryContext {
  return {
    idByName: sources.idByName,
    kindById: sources.kindById,
    ruleCategoryId: (m) => sources.rules.get(m)?.categoryId ?? null,
    inheritedCategoryId: inherited,
  };
}

/** The category of the latest categorized purchase at each merchant (null when there is none), for refunds to inherit. */
export async function latestPurchaseCategories(q: Db, user: CurrentUser, merchants: Iterable<string>): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const m of merchants) {
    if (!m || out.has(m)) continue;
    const hit = (
      await q
        .select({ categoryId: transactions.categoryId })
        .from(transactions)
        .where(and(eq(transactions.userId, user.id), eq(transactions.merchant, m), eq(transactions.kind, "expense"), isNotNull(transactions.categoryId)))
        .orderBy(desc(transactions.occurredAt), desc(transactions.id))
        .limit(1)
    )[0];
    out.set(m, hit?.categoryId ?? null);
  }
  return out;
}
