import { z } from "zod";
import { CaptureInfo, ProvisionalTotals } from "./capture";
import { CurrencyCode, DateString, Id, MonthString, QueryFlag, QueryId } from "./common";

export const TransactionKind = z.enum(["expense", "income", "transfer", "refund"]);
export type TransactionKind = z.infer<typeof TransactionKind>;

/** GET /api/transactions query string. */
export const TransactionQuery = z.object({
  month: MonthString.optional(),
  /** First day, inclusive. */
  from: DateString.optional(),
  /** Last day, inclusive. */
  to: DateString.optional(),
  q: z.string().optional(),
  categoryId: QueryId.optional(),
  kind: TransactionKind.optional(),
  participantId: QueryId.optional(),
  uncategorized: QueryFlag.optional(),
  /** Unsplit expenses of my own accounts (backfill triage). */
  unsplit: QueryFlag.optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type TransactionQuery = z.infer<typeof TransactionQuery>;

export const SplitItem = z.object({
  participantId: z.int(),
  name: z.string(),
  isSelf: z.boolean(),
  owedMinor: z.int(),
  paidMinor: z.int(),
});
export type SplitItem = z.infer<typeof SplitItem>;

/** Why a split is suggested: a stable code plus params the UI translates (names come from participantIds). */
export const SuggestionReason = z.object({
  code: z.enum(["suggest_merchant_recent", "suggest_merchant_before", "suggest_category_share"]),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type SuggestionReason = z.infer<typeof SuggestionReason>;

export const SplitSuggestion = z.object({
  participantIds: z.array(z.int()),
  source: z.enum(["merchant", "category", "none"]),
  confidence: z.number().min(0).max(1),
  reason: SuggestionReason.nullable(),
});
export type SplitSuggestion = z.infer<typeof SplitSuggestion>;

export const TransactionItem = z.object({
  id: z.int(),
  occurredAt: z.string(),
  /** Day of occurredAt in the user's time zone. */
  occurredOn: z.string(),
  amountMinor: z.int(),
  currency: CurrencyCode,
  originalAmountMinor: z.int().nullable(),
  originalCurrency: z.string().nullable(),
  kind: TransactionKind,
  status: z.enum(["ok", "closed"]),
  merchant: z.string(),
  counterpartyRaw: z.string(),
  description: z.string(),
  sourceCategory: z.string().nullable(),
  note: z.string().nullable(),
  categoryId: z.int().nullable(),
  categoryName: z.string().nullable(),
  accountId: z.int().nullable(),
  accountName: z.string().nullable(),
  source: z.enum(["alipay", "wechat", "icbc_pdf", "plaid", "boa_csv", "sms", "manual"]),
  importBatchId: z.int().nullable(),
  duplicateOfId: z.int().nullable(),
  userEditedAt: z.string().nullable(),
  /** capture: from a pasted SMS no statement has confirmed yet (counted, labelled); hold: a card hold (not counted). */
  provisional: z.enum(["capture", "hold"]).nullable(),
  /** The capture behind the row (a pasted SMS); null for other rows. */
  capture: CaptureInfo.nullable(),
  splits: z.array(SplitItem),
  /** What the row adds to my spending: positive = spent, refunds negative, 0 when not counted. */
  myShareMinor: z.int(),
  suggestedParticipantIds: z.array(z.int()),
  /** Split suggestion for an unsplit expense row (merchant rule, else the category's learned set); null when none. */
  suggestion: SplitSuggestion.nullable(),
});
export type TransactionItem = z.infer<typeof TransactionItem>;

export const CurrencyTotal = ProvisionalTotals.extend({
  currency: CurrencyCode,
  count: z.int().nonnegative(),
  spendingMinor: z.int(),
});
export type CurrencyTotal = z.infer<typeof CurrencyTotal>;

export const TransactionPage = z.object({
  items: z.array(TransactionItem),
  total: z.int().nonnegative(),
  /** Spending per currency for the month or range; present when the query names a month or from + to. */
  totals: z.array(CurrencyTotal).optional(),
});
export type TransactionPage = z.infer<typeof TransactionPage>;

export const TransactionPatch = z
  .object({
    categoryId: Id.nullable().optional(),
    kind: TransactionKind.optional(),
    note: z.string().max(500).nullable().optional(),
    merchant: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type TransactionPatch = z.infer<typeof TransactionPatch>;

export const BulkUpdateInput = z
  .object({
    ids: z.array(Id).min(1).max(2000),
    categoryId: Id.nullable().optional(),
    kind: TransactionKind.optional(),
  })
  .strict()
  .refine((v) => v.categoryId !== undefined || v.kind !== undefined, { message: "categoryId or kind is required" });
export type BulkUpdateInput = z.infer<typeof BulkUpdateInput>;

/** skippedSplit: rows left alone because a kind change would take a split row out of expense/refund. */
export const BulkUpdateResult = z.object({ updated: z.int().nonnegative(), skippedSplit: z.int().nonnegative() });
export type BulkUpdateResult = z.infer<typeof BulkUpdateResult>;

export const SetCategoryInput = z
  .object({ categoryId: Id, applyToMerchant: z.boolean().default(false) })
  .strict();
export type SetCategoryInput = z.infer<typeof SetCategoryInput>;

export const SetCategoryResult = z.object({ affected: z.int().nonnegative() });
export type SetCategoryResult = z.infer<typeof SetCategoryResult>;

export const CategoryKind = z.enum(["expense", "income"]);

export const Category = z.object({
  id: z.int(),
  name: z.string(),
  kind: CategoryKind,
  isSystem: z.boolean(),
  sort: z.int(),
  archivedAt: z.string().nullable(),
  /** Dictionary key of a system category (`dining`, `salary`, ...); null for categories the user made. */
  key: z.string().nullable(),
  /** Income on this category counts in income totals and the savings rate (income categories). */
  countsAsIncome: z.boolean(),
});
export type Category = z.infer<typeof Category>;

export const CategoryList = z.object({ categories: z.array(Category) });
export type CategoryList = z.infer<typeof CategoryList>;

export const CreateCategoryInput = z.object({ name: z.string().trim().min(1).max(40), kind: CategoryKind }).strict();
export type CreateCategoryInput = z.infer<typeof CreateCategoryInput>;

export const UpdateCategoryInput = z
  .object({ name: z.string().trim().min(1).max(40).optional(), archived: z.boolean().optional(), countsAsIncome: z.boolean().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.archived !== undefined || v.countsAsIncome !== undefined, {
    message: "name, archived or countsAsIncome is required",
  });
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInput>;

export const MonthCount = z.object({ month: MonthString, count: z.int().nonnegative() });
export const MonthList = z.object({ months: z.array(MonthCount) });
export type MonthList = z.infer<typeof MonthList>;

export const RecategorizeResult = z.object({
  scanned: z.int().nonnegative(),
  categoryChanged: z.int().nonnegative(),
  merchantChanged: z.int().nonnegative(),
  kindChanged: z.int().nonnegative(),
});
export type RecategorizeResult = z.infer<typeof RecategorizeResult>;
