import { z } from "zod";
import { CurrencyCode, DateString, Id } from "./common";

// Captures (a pasted card SMS) and their review queue. Shaped so the v0.3 MCP tools can return the same objects.

export const CaptureKind = z.enum(["sms", "screenshot", "agent", "manual", "plaid_pending"]);
export type CaptureKind = z.infer<typeof CaptureKind>;

export const CaptureState = z.enum(["proposed", "provisional", "confirmed", "superseded", "enriched", "released", "discarded", "rejected"]);
export type CaptureState = z.infer<typeof CaptureState>;

/** ambiguous: several rows fit; near_miss: one nearly fits; stale: no row came; amount_changed: an exact split no longer adds up. */
export const ReviewType = z.enum(["ambiguous", "near_miss", "stale", "amount_changed"]);
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

export const ReviewItem = z.object({
  captureId: z.int(),
  type: ReviewType,
  capture: ReviewCapture,
  candidates: z.array(MatchCandidate),
  stale: StaleReason.nullable(),
  shares: z.object({ sharesMinor: z.int(), amountMinor: z.int() }).nullable(),
  createdAt: z.string(),
});
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

/** Result of a resolution or an undo (POST /api/captures/:captureId/undo). */
export const ResolveResult = z.object({ captureIds: z.array(z.int()), states: z.array(CaptureState) });
export type ResolveResult = z.infer<typeof ResolveResult>;
