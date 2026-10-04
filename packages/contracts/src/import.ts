import { z } from "zod";
import { CurrencyCode, MessageParams, Notice, QueryFlag, SourceId } from "./common";

/** POST /api/import/commit flags, as form fields or in the query string: force imports a file imported before. */
export const ImportFlags = z.object({ force: QueryFlag.optional() });

export const Bucket = z.object({ count: z.int().nonnegative(), minor: z.int().nonnegative() });
export type Bucket = z.infer<typeof Bucket>;

/** Counts and Σ|amount| (minor units, summed across currencies as statements do). */
export const Totals = z.object({
  count: z.int().nonnegative().optional(),
  income: Bucket.optional(),
  expense: Bucket.optional(),
  neutral: Bucket.optional(),
});
export type Totals = z.infer<typeof Totals>;

export const ReconciliationBucket = z.object({
  bucket: z.enum(["expense", "income", "neutral"]),
  declared: Bucket.nullable(),
  parsed: Bucket,
  ok: z.boolean(),
});

export const Reconciliation = z.object({
  ok: z.boolean(),
  count: z.object({ declared: z.int().nullable(), parsed: z.int(), ok: z.boolean() }),
  buckets: z.array(ReconciliationBucket),
});
export type Reconciliation = z.infer<typeof Reconciliation>;

export const CurrencySpending = z.object({
  currency: CurrencyCode,
  count: z.int().nonnegative(),
  spendingMinor: z.int(),
});

export const AccountToCreate = z.object({
  name: z.string(),
  kind: z.enum(["wallet", "debit_card", "credit_card"]),
  institution: z.string().nullable(),
  last4: z.string().nullable(),
  currency: CurrencyCode,
});

export const ParticipantSuggestion = z.object({
  lineNo: z.int(),
  transactionId: z.int().nullable(),
  merchant: z.string(),
  participantIds: z.array(z.int()),
});

export const ImportPreview = z.object({
  source: SourceId,
  fileName: z.string(),
  fileHash: z.string().regex(/^[0-9a-f]{64}$/),
  alreadyImported: z.boolean(),
  existingBatchId: z.int().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  rowsTotal: z.int().nonnegative(),
  newCount: z.int().nonnegative(),
  dupCount: z.int().nonnegative(),
  linkCount: z.int().nonnegative(),
  closedCount: z.int().nonnegative(),
  reconciliation: Reconciliation,
  spending: z.array(CurrencySpending),
  accountsToCreate: z.array(AccountToCreate),
  participantSuggestions: z.array(ParticipantSuggestion),
  /** New expense rows split automatically on commit (merchant rules with auto-split on). */
  autoSplit: z.int().nonnegative(),
  warnings: z.array(Notice),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportResult = ImportPreview.extend({
  batchId: z.int(),
  inserted: z.int().nonnegative(),
  skippedDup: z.int().nonnegative(),
  linked: z.int().nonnegative(),
  /** Pasted card alerts this import confirmed, and the size of the review queue after it. */
  captures: z.object({ linked: z.int().nonnegative(), toReview: z.int().nonnegative() }),
  /** Rows high-confidence own-account transfer rules made transfers (new rows, or the other leg of one). */
  ownTransfers: z.int().nonnegative(),
});
export type ImportResult = z.infer<typeof ImportResult>;

export const BatchSummary = z.object({
  id: z.int(),
  source: SourceId,
  fileName: z.string(),
  fileHash: z.string(),
  rowsTotal: z.int().nonnegative(),
  rowsInserted: z.int().nonnegative(),
  rowsSkippedDup: z.int().nonnegative(),
  rowsLinked: z.int().nonnegative(),
  declared: Totals.nullable(),
  parsed: Totals.nullable(),
  status: z.enum(["committed", "reverted"]),
  createdAt: z.string(),
  revertedAt: z.string().nullable(),
});
export type BatchSummary = z.infer<typeof BatchSummary>;

export const BatchList = z.object({ batches: z.array(BatchSummary) });
export type BatchList = z.infer<typeof BatchList>;

export const RevertResult = z.object({
  batchId: z.int(),
  deleted: z.int().nonnegative(),
  keptEdited: z.int().nonnegative(),
});
export type RevertResult = z.infer<typeof RevertResult>;

/** Error body: English `error`, a stable snake_case `code` the UI translates, and `params` for its placeholders. */
export const ApiError = z.object({ error: z.string(), code: z.string().optional(), params: MessageParams.optional() });
export type ApiError = z.infer<typeof ApiError>;
