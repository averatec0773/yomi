import { z } from "zod";
import { Currency, CurrencyCode, DateString, Id, TransactionKind } from "./common";

// Captures (a pasted card SMS) and their review queue. Shaped so the v0.3 MCP tools can return the same objects.

export const CaptureKind = z.enum(["sms", "screenshot", "agent", "manual", "plaid_pending"]);
export type CaptureKind = z.infer<typeof CaptureKind>;

export const CaptureState = z.enum(["proposed", "provisional", "confirmed", "superseded", "enriched", "released", "discarded", "rejected"]);
export type CaptureState = z.infer<typeof CaptureState>;

/** ambiguous: several rows fit; near_miss: one nearly fits; stale: no row came; amount_changed: an exact split no longer adds up. */
export const CaptureReviewType = z.enum(["ambiguous", "near_miss", "stale", "amount_changed"]);
export type CaptureReviewType = z.infer<typeof CaptureReviewType>;

/** Capture items, plus ledger rows that look like a friend paying me back (repayment) or money between my own accounts (own_transfer). */
export const ReviewType = z.enum([...CaptureReviewType.options, "repayment", "own_transfer"]);
export type ReviewType = z.infer<typeof ReviewType>;

export const MatchReason = z.enum(["amount", "card", "merchant", "time"]);
export type MatchReason = z.infer<typeof MatchReason>;

/** What a period's total of one currency rests on that no statement has confirmed yet. */
export const ProvisionalTotals = z.object({
  /** Provisional captures counted in the total: rows and my share of them. */
  provisional: z.object({ count: z.int().nonnegative(), minor: z.int() }),
  /** Card holds not counted: rows and their amount. */
  holds: z.object({ count: z.int().nonnegative(), minor: z.int() }),
});
export type ProvisionalTotals = z.infer<typeof ProvisionalTotals>;

/** The capture behind a transaction row (details panel). */
export const CaptureInfo = z.object({
  id: z.int(),
  kind: CaptureKind,
  state: CaptureState,
  /** As captured, with its own offset (ICBC SMS: Beijing time). */
  occurredAt: z.string(),
  authorityId: z.int().nullable(),
  authoritySource: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  canUndo: z.boolean(),
});
export type CaptureInfo = z.infer<typeof CaptureInfo>;

export const ReviewCapture = z.object({
  kind: CaptureKind,
  transactionId: z.int(),
  occurredAt: z.string(),
  occurredOn: DateString,
  amountMinor: z.int(),
  currency: CurrencyCode,
  last4: z.string().nullable(),
  hold: z.boolean(),
  merchant: z.string(),
});
export type ReviewCapture = z.infer<typeof ReviewCapture>;

/** A ledger row offered for a capture, with what agrees ("amount", "card", "merchant", "time"). */
export const MatchCandidate = z.object({
  transactionId: z.int(),
  source: z.string(),
  occurredAt: z.string(),
  occurredOn: DateString,
  amountMinor: z.int(),
  currency: CurrencyCode,
  merchant: z.string(),
  reasons: z.array(MatchReason),
  /** Candidate day minus capture day. */
  daysAfter: z.int(),
  /** |candidate| − |capture| in the capture's currency (a tip on a hold), else 0. */
  amountDiffMinor: z.int(),
});
export type MatchCandidate = z.infer<typeof MatchCandidate>;

export const StaleReason = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("covered"), source: z.literal("icbc_pdf"), through: DateString }),
  z.object({ reason: z.literal("age"), days: z.int().nonnegative() }),
]);
export type StaleReason = z.infer<typeof StaleReason>;

export const CaptureReviewItem = z.object({
  subject: z.literal("capture"),
  captureId: z.int(),
  type: CaptureReviewType,
  capture: ReviewCapture,
  candidates: z.array(MatchCandidate),
  stale: StaleReason.nullable(),
  shares: z.object({ sharesMinor: z.int(), amountMinor: z.int() }).nullable(),
  createdAt: z.string(),
});
export type CaptureReviewItem = z.infer<typeof CaptureReviewItem>;

/** The ledger row a transaction item is about. */
export const ReviewRow = z.object({
  transactionId: z.int(),
  occurredAt: z.string(),
  occurredOn: DateString,
  amountMinor: z.int(),
  currency: CurrencyCode,
  kind: TransactionKind,
  source: z.string(),
  merchant: z.string(),
  accountName: z.string().nullable(),
  categoryId: z.int().nullable(),
});
export type ReviewRow = z.infer<typeof ReviewRow>;

/** own_name · pair · broker · hint (the bank calls it a transfer, nothing else confirms it). */
export const KindRule = z.enum(["own_name", "pair", "broker", "hint"]);
export type KindRule = z.infer<typeof KindRule>;

/** name · pair · pairs (several rows could be the other leg) · broker · investment (the brokerage has it too) · bank. */
export const TransferReason = z.enum(["name", "pair", "pairs", "broker", "investment", "bank"]);
export type TransferReason = z.infer<typeof TransferReason>;

export const Confidence = z.enum(["high", "medium"]);
export type Confidence = z.infer<typeof Confidence>;

export const OwnTransferItem = z.object({
  subject: z.literal("transaction"),
  type: z.literal("own_transfer"),
  transactionId: z.int(),
  row: ReviewRow,
  /** The other leg, when it is in the ledger. */
  peer: ReviewRow.nullable(),
  proposal: z.object({ peerId: z.int().nullable(), rule: KindRule, confidence: Confidence, reasons: z.array(TransferReason) }),
});
export type OwnTransferItem = z.infer<typeof OwnTransferItem>;

/** name · balance (equals what is open) · items (equals certain open items) · partial · time · fx (compared in another currency). */
export const RepaymentReason = z.enum(["name", "balance", "items", "partial", "time", "fx"]);
export type RepaymentReason = z.infer<typeof RepaymentReason>;

export const RepaymentProposal = z.object({
  participantId: z.int(),
  participantName: z.string(),
  /** The open items it pays; empty for a partial payment. */
  itemTransactionIds: z.array(z.int()),
  items: z.array(z.object({ transactionId: z.int(), date: DateString, merchant: z.string(), remainingMinor: z.int() })),
  amountMinor: z.int(),
  currency: CurrencyCode,
  /** What stays open with them after it, in `currency`. */
  balanceAfterMinor: z.int(),
  confidence: Confidence,
  reasons: z.array(RepaymentReason),
  /** A settlement recorded by hand with the same amount within 3 days. */
  possiblyCovered: z.object({ settlementId: z.int(), amountMinor: z.int(), currency: CurrencyCode, settledOn: DateString }).nullable(),
});
export type RepaymentProposal = z.infer<typeof RepaymentProposal>;

export const RepaymentReviewItem = z.object({
  subject: z.literal("transaction"),
  type: z.literal("repayment"),
  transactionId: z.int(),
  row: ReviewRow,
  proposal: RepaymentProposal,
});
export type RepaymentReviewItem = z.infer<typeof RepaymentReviewItem>;

export const ReviewItem = z.union([CaptureReviewItem, RepaymentReviewItem, OwnTransferItem]);
export type ReviewItem = z.infer<typeof ReviewItem>;

/** GET /api/review */
export const ReviewList = z.object({
  items: z.array(ReviewItem),
  counts: z.record(ReviewType, z.int().nonnegative()),
  total: z.int().nonnegative(),
});
export type ReviewList = z.infer<typeof ReviewList>;

/**
 * link (needs candidateId, one of the item's candidates) · keep_separate · keep_final · discard · keep_shares.
 * Which apply depends on the item's type; the server refuses the others (capture_action_invalid).
 */
export const ReviewAction = z.enum(["link", "keep_separate", "keep_final", "discard", "keep_shares"]);
export type ReviewAction = z.infer<typeof ReviewAction>;

/** POST /api/review/:captureId */
export const ResolveBody = z
  .object({ action: ReviewAction, candidateId: Id.optional() })
  .strict()
  .refine((b) => b.action !== "link" || b.candidateId !== undefined, { message: "link needs candidateId", path: ["candidateId"] });
export type ResolveBody = z.infer<typeof ResolveBody>;

export const BulkReviewAction = z.enum(["keep_separate", "keep_final", "discard"]);
export type BulkReviewAction = z.infer<typeof BulkReviewAction>;

/** POST /api/review/bulk: one action on several items, all or nothing. */
export const BulkResolveBody = z.object({ captureIds: z.array(Id).min(1).max(500), action: BulkReviewAction }).strict();
export type BulkResolveBody = z.infer<typeof BulkResolveBody>;

/**
 * POST /api/review/transactions/:transactionId. settle: the row is a repayment from `participantId` (paying
 * `itemTransactionIds`, for `amountMinor` in `currency` when given); Undo is DELETE /api/settlements/:id. own_transfer:
 * the proposal is right (the row and its peer become transfers). income: the row is income in `categoryId` (an income
 * category) and is not proposed again. dismiss: not a repayment or transfer, never proposed again.
 */
export const TransactionReviewAction = z.enum(["settle", "own_transfer", "income", "dismiss"]);
export type TransactionReviewAction = z.infer<typeof TransactionReviewAction>;

export const TransactionReviewBody = z
  .object({
    action: TransactionReviewAction,
    participantId: Id.optional(),
    itemTransactionIds: z.array(Id).max(2000).optional(),
    amountMinor: z.int().positive().optional(),
    currency: Currency.optional(),
    categoryId: Id.optional(),
  })
  .strict()
  .refine((b) => b.action !== "income" || b.categoryId !== undefined, { message: "income needs categoryId", path: ["categoryId"] })
  .refine((b) => b.action !== "settle" || b.participantId !== undefined, { message: "settle needs participantId", path: ["participantId"] });
export type TransactionReviewBody = z.infer<typeof TransactionReviewBody>;

/** The row's fields before an action, as the action returns them; Undo puts them back. */
export const ReviewPrior = z
  .object({ kind: TransactionKind, categoryId: Id.nullable(), userEditedAt: z.string().nullable(), reviewDismissedAt: z.string().nullable() })
  .strict();
export type ReviewPrior = z.infer<typeof ReviewPrior>;

export const TransactionReviewResult = z.object({
  transactionId: z.int(),
  kind: TransactionKind,
  prior: ReviewPrior,
  /** settle: the settlement recorded (Undo deletes it). */
  settlementId: z.int().nullable(),
});
export type TransactionReviewResult = z.infer<typeof TransactionReviewResult>;

/** POST /api/review/transactions/bulk: confirm several own-account transfers, all or nothing. */
export const BulkTransactionReviewBody = z.object({ transactionIds: z.array(Id).min(1).max(500), action: z.literal("own_transfer") }).strict();
export type BulkTransactionReviewBody = z.infer<typeof BulkTransactionReviewBody>;

export const BulkTransactionReviewResult = z.object({ results: z.array(TransactionReviewResult) });
export type BulkTransactionReviewResult = z.infer<typeof BulkTransactionReviewResult>;

/** POST /api/review/transactions/:transactionId/undo: the action taken (settle is undone by deleting the settlement) and the `prior` it returned. */
export const TransactionReviewUndoBody = z.object({ action: TransactionReviewAction.exclude(["settle"]), prior: ReviewPrior }).strict();
export type TransactionReviewUndoBody = z.infer<typeof TransactionReviewUndoBody>;

/** Result of a resolution or an undo (POST /api/captures/:captureId/undo). */
export const ResolveResult = z.object({ captureIds: z.array(z.int()), states: z.array(CaptureState) });
export type ResolveResult = z.infer<typeof ResolveResult>;
