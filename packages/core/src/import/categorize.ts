import type { NormalizedRow } from "@yomi/importers";

// Ordered: first hit wins, so the more specific patterns come first. Matched against the
// uppercased `merchant counterparty description`.
export const KEYWORD_CATEGORIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/UBER\s*\*?\s*EATS|DOORDASH|美团|饿了么/, "餐饮"],
  [/\bUBER\b|\bLYFT\b/, "交通"],
  [/网易云音乐|QQ音乐|抖音|爱奇艺|腾讯视频|BILIBILI|哔哩哔哩|APPLE\s?MUSIC/, "订阅"],
  // AI assistants billed monthly.
  [/ANTHROPIC|\bCLAUDE\b|CLAUDE\.AI|OPENAI|CHATGPT/, "订阅"],
  [/腾讯天游|NETEASE|网易|NINTENDO|BLIZZARD|\bVALVE\b|\bSTEAM/, "娱乐"],
  [/联通|(?:中国)?移动(?!支付|端)|电信|话费/, "居住"],
  [/AMAZON|AMZN|WALMART|WAL-MART|\bTARGET\b|得物|淘宝|天猫|京东|拼多多/, "购物"],
  [
    /\bH-?E-?B\b|99\s?RANCH|WEEE|KROGER|H\s?MART|COSTCO|TRADER\s?JOE|WHOLE\s?FOODS|SAFEWAY/,
    "买菜",
  ],
  [/NETFLIX|SPOTIFY|LINKEDIN|GOOGLE|APPLE\.COM/, "订阅"],
  [
    /JETBLUE|DELTA\s?AIR|^DELTA\b|UNITED\s?AIR|UNITED\.COM|^UNITED\b|AMERICAN\s?AIR|SOUTHWEST|AIRBNB|HOTEL|MARRIOTT|HILTON|EXPEDIA/,
    "旅行",
  ],
  [/UNIVERSITY|COLLEGE|COURSERA|UDEMY/, "教育"],
  [/PHARMACY|\bCVS\b|WALGREENS|CLINIC|HOSPITAL/, "医疗"],
  [
    /MCDONALD|HAIDILAO|\bPHO\b|KITCHEN|\bCAFE\b|COFFEE|\bTEA\b|\bBOBA\b|NOODLE|RAMEN|\bBBQ\b|BURGER|PIZZA|SUSHI|\bGRILL\b|BAKERY|DUMPLING|HOT\s?POT|TACO|CHICKEN|RESTAURANT|\bDINER\b|BISTRO|餐厅|饭店|小吃|奶茶|咖啡/,
    "餐饮",
  ],
  // Income words last, so a merchant name above wins for spending; they only apply to income rows (see resolveCategoryId).
  [/REBATE|CASH\s?BACK|\bREWARDS?\b/, "返现"],
  [/余额宝.*收益|\bINTEREST\b|利息/, "利息"],
];

const ALIPAY_CATEGORIES: Record<string, string> = {
  餐饮美食: "餐饮",
  日用百货: "日用",
  文化休闲: "娱乐",
  服饰装扮: "购物",
  教育培训: "教育",
  运动户外: "娱乐",
  家居家装: "居住",
  交通出行: "交通",
  充值缴费: "居住",
  收入: "其他收入",
};

// Plaid personal_finance_category (https://plaid.com/docs/transactions/pfc-migration/), stored as
// "PRIMARY/DETAILED". Only a fallback after merchant rules and keywords. Primaries not listed
// (BANK_FEES, HOME_IMPROVEMENT, GOVERNMENT_AND_NON_PROFIT, LOAN_*, OTHER) fall through to 其他.
const PLAID_PRIMARY_CATEGORIES: Record<string, string> = {
  FOOD_AND_DRINK: "餐饮",
  TRANSPORTATION: "交通",
  TRAVEL: "旅行",
  GENERAL_MERCHANDISE: "购物",
  ENTERTAINMENT: "娱乐",
  RENT_AND_UTILITIES: "居住",
  MEDICAL: "医疗",
  PERSONAL_CARE: "日用",
  GENERAL_SERVICES: "其他",
  INCOME: "其他收入",
};
// Plaid's detailed key for pay is INCOME_WAGES; INCOME_SALARY is mapped too in case a feed uses it.
const PLAID_DETAILED_CATEGORIES: Record<string, string> = {
  FOOD_AND_DRINK_GROCERIES: "买菜",
  INCOME_WAGES: "工资",
  INCOME_SALARY: "工资",
  INCOME_INTEREST_EARNED: "利息",
  INCOME_DIVIDENDS: "利息",
};

// Bank of America CSV sourceCategory (set by the importer from the description). Kind-dependent ones
// are resolved in sourceCategoryName; Purchase / ACH / Transfer / ATM fall through.
const BOA_CATEGORIES: Record<string, { expense?: string; income?: string }> = {
  Zelle: { expense: "人情", income: "其他收入" },
  Wire: { expense: "其他", income: "其他收入" },
  Fee: { expense: "其他" },
  Payroll: { income: "工资" },
  Interest: { income: "利息" },
  Rewards: { income: "返现" },
  Deposit: { income: "其他收入" },
};

function plaidCategoryName(sc: string): string | null {
  const [primary = "", detailed = ""] = sc.split("/");
  return PLAID_DETAILED_CATEGORIES[detailed] ?? PLAID_PRIMARY_CATEGORIES[primary] ?? null;
}

export function keywordCategoryName(haystack: string): string | null {
  const s = haystack.toUpperCase();
  for (const [re, name] of KEYWORD_CATEGORIES) if (re.test(s)) return name;
  return null;
}

/** Category implied by the source's own classification. `退款` returns null (refunds inherit instead). */
export function sourceCategoryName(row: { source: string; sourceCategory: string | null; kind?: string }): string | null {
  const sc = row.sourceCategory?.trim();
  if (!sc) return null;
  if (row.source === "boa_csv") {
    const m = BOA_CATEGORIES[sc];
    return (row.kind === "income" ? m?.income : m?.expense) ?? null;
  }
  if (row.source === "alipay") return ALIPAY_CATEGORIES[sc] ?? null;
  if (row.source === "plaid") return plaidCategoryName(sc);
  if (row.source === "wechat") {
    // Returned 红包 / transfers net against 人情; other refunds inherit from the purchase.
    if (sc.endsWith("退款")) return /^(转账|微信红包)/.test(sc) ? "人情" : null;
    if (sc === "转账" || sc.startsWith("微信红包")) return "人情";
    if (sc === "分分捐") return "公益";
    if (sc === "二维码收款") return "其他收入";
  }
  return null;
}

export interface CategoryContext {
  idByName: ReadonlyMap<string, number>;
  kindById: ReadonlyMap<number, "expense" | "income">;
  /** Category id from merchant_rules for this cleaned merchant, if any. */
  ruleCategoryId(merchant: string): number | null;
  /** Category of an earlier purchase at the same merchant (for refunds). */
  inheritedCategoryId(merchant: string): number | null;
}

/**
 * Order: merchant rule → keyword table → (refunds: category of the purchase at the same merchant)
 * → source classification → 其他 / 其他收入. Transfers get no category. Income rows only take
 * income categories and expense rows only expense ones; refunds take either.
 */
/** The fields categorization reads; a NormalizedRow or a stored transaction both fit. */
export type CategorizableRow = Pick<NormalizedRow, "kind" | "counterparty" | "description" | "sourceCategory"> & {
  source: string;
};

export function resolveCategoryId(row: CategorizableRow, merchant: string, ctx: CategoryContext): number | null {
  if (row.kind === "transfer") return null;
  const rule = merchant ? ctx.ruleCategoryId(merchant) : null;
  if (rule != null) return rule;

  const fits = (id: number | null | undefined): id is number => {
    if (id == null) return false;
    const kind = ctx.kindById.get(id);
    if (row.kind === "income") return kind === "income";
    if (row.kind === "expense") return kind === "expense";
    return true;
  };
  const byName = (name: string | null) => (name ? ctx.idByName.get(name) : undefined);

  const kw = byName(keywordCategoryName(`${merchant} ${row.counterparty} ${row.description}`));
  if (fits(kw)) return kw;
  if (row.kind === "refund" && merchant) {
    const inherited = ctx.inheritedCategoryId(merchant);
    if (fits(inherited)) return inherited;
  }
  const mapped = byName(sourceCategoryName(row));
  if (fits(mapped)) return mapped;
  return byName(row.kind === "income" ? "其他收入" : "其他") ?? null;
}
