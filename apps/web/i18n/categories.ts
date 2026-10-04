import type { Dictionary } from "./en";

/** Seeded system category names (stored in Chinese in the DB) → dictionary key. */
const SYSTEM: Record<string, keyof Dictionary["categories"]> = {
  餐饮: "dining",
  买菜: "groceries",
  交通: "transport",
  购物: "shopping",
  日用: "household",
  居住: "housing",
  娱乐: "entertainment",
  订阅: "subscriptions",
  医疗: "medical",
  教育: "education",
  旅行: "travel",
  人情: "gifts",
  公益: "charity",
  其他: "other",
  工资: "salary",
  奖金: "bonus",
  利息: "interest",
  返现: "cashback",
  家人资助: "familySupport",
  报销: "reimbursement",
  副业收入: "sideIncome",
  退款: "refunds",
  转入: "transfersIn",
  其他收入: "otherIncome",
};

/** Display name for a stored category name: system categories translate, user-created ones show as stored. */
export function categoryLabel(name: string, t: Dictionary): string {
  const key = SYSTEM[name];
  return key ? t.categories[key] : name;
}
