import { categories, type Db, participants } from "@yomi/db";
import { getCurrentUser } from "./user";

export const SELF_PARTICIPANT_NAME = "我";

export const SYSTEM_EXPENSE_CATEGORIES = [
  "餐饮", "买菜", "交通", "购物", "日用", "居住", "娱乐", "订阅", "医疗", "教育", "旅行", "人情", "公益", "其他",
] as const;

export const SYSTEM_INCOME_CATEGORIES = ["工资", "退款", "转入", "其他收入"] as const;

/** Inserts the self participant and system categories for the current user. Safe to run repeatedly. */
export async function seed(db: Db): Promise<void> {
  const userId = getCurrentUser().id;
  await db.transaction(async (tx) => {
    await tx.insert(participants)
      .values({ userId, name: SELF_PARTICIPANT_NAME, isSelf: true, aliases: "[]" })
      .onConflictDoNothing();
    const rows = [
      ...SYSTEM_EXPENSE_CATEGORIES.map((name, i) => ({ userId, name, kind: "expense" as const, isSystem: true, sort: i })),
      ...SYSTEM_INCOME_CATEGORIES.map((name, i) => ({ userId, name, kind: "income" as const, isSystem: true, sort: i })),
    ];
    await tx.insert(categories).values(rows).onConflictDoNothing();
  });
}
