import { categories, merchantRules, transactions, transactionSplits, type Db } from "@yomi/db";
import { and, desc, eq, gte, isNull, like } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { userToday } from "../settings/time-zone";
import { addDays } from "../time/day";
import { listParticipants } from "./participants";
import { suggestSplits } from "./suggest";

const SHARED_CATEGORIES = ["买菜", "居住", "餐饮"];
/** Minimum |amount| (minor units) for a category-based suggestion; other currencies are skipped. */
const THRESHOLD_MINOR: Record<string, number> = { USD: 3000, CNY: 20000 };
const WINDOW_DAYS = 60;
const CAP = 20;

export interface UnsplitSuggestion {
  transactionId: number;
  occurredAt: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  categoryName: string | null;
  reason: "merchant_rule" | "category";
  suggestedParticipantIds: number[];
}

/**
 * The "Split these?" list: unsplit expenses with a split suggestion (suggest.ts: merchant rule, else the category's
 * learned set; reason "merchant_rule" / "category"), plus large groceries / housing / dining (买菜 / 居住 / 餐饮)
 * expenses. Dismissed rows and merchants marked "don't suggest" are left out. Default window: last 60 days; `month` (YYYY-MM) replaces it. Max 20, newest first.
 */
export async function unsplitSuggestions(
  db: Db,
  user: CurrentUser,
  opts: { month?: string; today?: string } = {},
): Promise<UnsplitSuggestion[]> {
  const today = opts.today ?? (await userToday(db, user));
  const fallback = (await listParticipants(db, user)).find((p) => !p.isSelf && p.archivedAt === null)?.id;
  const muted = new Set(
    (await db
      .select({ merchant: merchantRules.merchant })
      .from(merchantRules)
      .where(and(eq(merchantRules.userId, user.id), eq(merchantRules.suggest, false)))
      )
      .map((r) => r.merchant),
  );

  const rows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      merchant: transactions.merchant,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      kind: transactions.kind,
      status: transactions.status,
      duplicateOfId: transactions.duplicateOfId,
      splitSuggestionDismissedAt: transactions.splitSuggestionDismissedAt,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.transactionId, transactions.id))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.userId, user.id),
        eq(transactions.kind, "expense"),
        eq(transactions.status, "ok"),
        isNull(transactions.duplicateOfId),
        isNull(transactionSplits.id),
        isNull(transactions.splitSuggestionDismissedAt),
        opts.month
          ? like(transactions.occurredOn, `${opts.month}%`)
          : gte(transactions.occurredOn, addDays(today, -WINDOW_DAYS)),
      ),
    )
    .orderBy(desc(transactions.occurredAt), desc(transactions.id));
  const suggested = await suggestSplits(
    db,
    user,
    rows.map((r) => ({ ...r, hasSplits: false })),
    { today },
  );

  const out: UnsplitSuggestion[] = [];
  for (const r of rows) {
    if (out.length >= CAP) break;
    const s = suggested.get(r.id);
    if (s) {
      out.push({ ...pick(r), reason: s.source === "merchant" ? "merchant_rule" : "category", suggestedParticipantIds: s.participantIds });
      continue;
    }
    if (r.merchant && muted.has(r.merchant)) continue;
    const threshold = THRESHOLD_MINOR[r.currency];
    if (
      r.categoryName &&
      SHARED_CATEGORIES.includes(r.categoryName) &&
      threshold !== undefined &&
      -r.amountMinor >= threshold
    ) {
      out.push({ ...pick(r), reason: "category", suggestedParticipantIds: fallback ? [fallback] : [] });
    }
  }
  return out;
}

function pick(r: {
  id: number;
  occurredAt: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  categoryName: string | null;
}) {
  return {
    transactionId: r.id,
    occurredAt: r.occurredAt,
    merchant: r.merchant,
    amountMinor: r.amountMinor,
    currency: r.currency,
    categoryName: r.categoryName,
  };
}
