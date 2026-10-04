import { categories, type Db } from "@yomi/db";
import { eq } from "@yomi/db/orm";

/** A seeded category: its dictionary key (stable, English) and the stored name (zh-CN, the UI translates by key). */
export interface SystemCategory {
  key: string;
  name: string;
  /** Income categories only; false keeps the category's income out of income totals and the savings rate. */
  countsAsIncome?: boolean;
}

export const SYSTEM_EXPENSE_CATEGORIES: readonly SystemCategory[] = [
  { key: "dining", name: "餐饮" },
  { key: "groceries", name: "买菜" },
  { key: "transport", name: "交通" },
  { key: "shopping", name: "购物" },
  { key: "household", name: "日用" },
  { key: "housing", name: "居住" },
  { key: "entertainment", name: "娱乐" },
  { key: "subscriptions", name: "订阅" },
  { key: "medical", name: "医疗" },
  { key: "education", name: "教育" },
  { key: "travel", name: "旅行" },
  { key: "gifts", name: "人情" },
  { key: "charity", name: "公益" },
  { key: "other", name: "其他" },
];

export const SYSTEM_INCOME_CATEGORIES: readonly SystemCategory[] = [
  { key: "salary", name: "工资" },
  { key: "bonus", name: "奖金" },
  { key: "interest", name: "利息" },
  { key: "cashback", name: "返现" },
  { key: "familySupport", name: "家人资助" },
  // They repay spending already counted; counting them would inflate income and the savings rate.
  { key: "reimbursement", name: "报销", countsAsIncome: false },
  { key: "sideIncome", name: "副业收入" },
  { key: "otherIncome", name: "其他收入" },
];

/**
 * Income categories of earlier versions that mixed a kind (refund) and a non-income class (transfers in) into income.
 * Ledgers that have them get their keys and then have them archived (upgradeIncomeTaxonomy); new ledgers never do.
 */
export const LEGACY_INCOME_CATEGORIES: readonly SystemCategory[] = [
  { key: "refunds", name: "退款" },
  { key: "transfersIn", name: "转入" },
];

/**
 * Gives every system category its key and inserts the missing ones. A category of the same name and kind that exists
 * already (a system row of an earlier version, or one the user made, e.g. 利息) is adopted: it gets the key instead of
 * a duplicate. A same-named category of the other kind is left alone and that system category is skipped.
 */
export async function ensureSystemCategories(q: Db, userId: number): Promise<void> {
  const existing = await q.select().from(categories).where(eq(categories.userId, userId));
  const keyed = new Set(existing.flatMap((c) => (c.key ? [c.key] : [])));
  const byName = new Map(existing.map((c) => [c.name, c]));
  for (const legacy of LEGACY_INCOME_CATEGORIES) {
    const c = byName.get(legacy.name);
    if (c && c.isSystem && c.kind === "income" && c.key == null && !keyed.has(legacy.key)) {
      await q.update(categories).set({ key: legacy.key }).where(eq(categories.id, c.id));
    }
  }
  const lists = [
    { kind: "expense" as const, list: SYSTEM_EXPENSE_CATEGORIES },
    { kind: "income" as const, list: SYSTEM_INCOME_CATEGORIES },
  ];
  for (const { kind, list } of lists) {
    for (const [sort, def] of list.entries()) {
      if (keyed.has(def.key)) continue;
      const same = byName.get(def.name);
      if (same && (same.kind !== kind || same.key != null)) continue;
      if (same) {
        await q
          .update(categories)
          .set({ key: def.key, isSystem: true, sort, countsAsIncome: def.countsAsIncome ?? true })
          .where(eq(categories.id, same.id));
      } else {
        await q
          .insert(categories)
          .values({ userId, name: def.name, key: def.key, kind, isSystem: true, sort, countsAsIncome: def.countsAsIncome ?? true });
      }
    }
  }
}
