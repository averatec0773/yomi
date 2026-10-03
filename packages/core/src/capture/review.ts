import { captures, type CaptureState, type Db, importBatches, transactions } from "@yomi/db";
import { and, desc, eq, inArray, isNotNull, like, max, min, or } from "@yomi/db/orm";
import { getTimeZone } from "../settings/time-zone";
import { loadSplits } from "../ledger/transactions";
import { addDays, dayDiff, daysInclusive } from "../time/day";
import { todayIn } from "../time/zone";
import type { CurrentUser } from "../user";
import { type MatchReason, PDF_WINDOW, runMatching } from "./match";
import { CaptureError, type CaptureRow, captureRow, getCapture, recordResolution, supersede, undoResolution } from "./supersede";

// The review queue: open captures the matcher could not settle alone (ambiguous, near miss), captures no statement
// row arrived for (stale, derived when read), and confirmed captures whose exact split no longer adds up.

export const REVIEW_TYPES = ["ambiguous", "near_miss", "stale", "amount_changed"] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];
export type ReviewAction = "link" | "keep_separate" | "keep_final" | "discard" | "keep_shares";
/** Actions that apply to several items at once; choosing a candidate is always one at a time. */
export type BulkReviewAction = Extract<ReviewAction, "keep_separate" | "keep_final" | "discard">;

/** A provisional capture with no statement row this many days after its day is stale. */
export const STALE_AFTER_DAYS = 14;

export interface ReviewCapture {
  kind: CaptureRow["kind"];
  transactionId: number;
  occurredAt: string;
  /** Day in the user's time zone. */
  occurredOn: string;
  amountMinor: number;
  currency: string;
  last4: string | null;
  hold: boolean;
  merchant: string;
}

export interface ReviewCandidate {
  transactionId: number;
  source: string;
  occurredAt: string;
  occurredOn: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  reasons: MatchReason[];
  /** Candidate day minus capture day. */
  daysAfter: number;
  /** |candidate| − |capture| in the capture's currency when both are in it (a tip on a hold), else 0. */
  amountDiffMinor: number;
}

export type StaleReason = { reason: "covered"; source: "icbc_pdf"; through: string } | { reason: "age"; days: number };

export interface ReviewItem {
  captureId: number;
  type: ReviewType;
  capture: ReviewCapture;
  candidates: ReviewCandidate[];
  /** stale: why. */
  stale: StaleReason | null;
  /** amount_changed: the exact shares and the charge they no longer add up to (magnitudes). */
  shares: { sharesMinor: number; amountMinor: number } | null;
  createdAt: string;
}

export interface ReviewList {
  items: ReviewItem[];
  counts: Record<ReviewType, number>;
  total: number;
}

/** Days per card (last four) an imported ICBC statement covers: earliest start and furthest end over its batches. */
async function statementReach(q: Db, user: CurrentUser, cards: readonly string[]): Promise<Map<string, { from: string; through: string }>> {
  const out = new Map<string, { from: string; through: string }>();
  for (const last4 of cards) {
    const rows = await q
      .select({ start: importBatches.periodStart, end: importBatches.periodEnd, first: min(transactions.occurredOn), last: max(transactions.occurredOn) })
      .from(transactions)
      .innerJoin(importBatches, eq(importBatches.id, transactions.importBatchId))
      .where(
        and(
          eq(transactions.userId, user.id),
          eq(transactions.source, "icbc_pdf"),
          eq(importBatches.status, "committed"),
          like(transactions.paymentMethod, `%(${last4})`),
        ),
      )
      .groupBy(importBatches.id);
    if (rows.length === 0) continue;
    const from = rows.map((r) => r.start ?? r.first!).sort()[0]!;
    const through = rows.map((r) => [r.end, r.last].filter((d): d is string => d != null).sort().at(-1)!).sort().at(-1)!;
    out.set(last4, { from, through });
  }
  return out;
}

function staleReason(c: ReviewCapture, reach: Map<string, { from: string; through: string }>, today: string): StaleReason | null {
  const r = c.last4 ? reach.get(c.last4) : undefined;
  if (r && r.from <= c.occurredOn && r.through >= addDays(c.occurredOn, PDF_WINDOW.to)) return { reason: "covered", source: "icbc_pdf", through: r.through };
  const days = daysInclusive(c.occurredOn, today) - 1;
  return days >= STALE_AFTER_DAYS ? { reason: "age", days } : null;
}

function emptyCounts(): Record<ReviewType, number> {
  return { ambiguous: 0, near_miss: 0, stale: 0, amount_changed: 0 };
}

/**
 * The queue, read only (no writes on a read): stored reviews plus open captures that went stale, i.e. an imported
 * ICBC statement of the card covers the capture's day (and the matching window after it) without a match, or
 * STALE_AFTER_DAYS passed without one. `today` defaults to today in the user's time zone.
 */
export async function listReview(q: Db, user: CurrentUser, opts: { today?: string } = {}): Promise<ReviewList> {
  const today = opts.today ?? todayIn(await getTimeZone(q, user));
  const rows = await q
    .select({ c: captures, occurredOn: transactions.occurredOn, merchant: transactions.merchant, amountMinor: transactions.amountMinor, currency: transactions.currency })
    .from(captures)
    .innerJoin(transactions, eq(transactions.id, captures.transactionId))
    .where(and(eq(captures.userId, user.id), or(eq(captures.state, "provisional"), isNotNull(captures.review))))
    .orderBy(desc(captures.occurredAt), desc(captures.id));
  const reach = await statementReach(q, user, [...new Set(rows.flatMap((r) => (r.c.state === "provisional" && !r.c.review && r.c.last4 ? [r.c.last4] : [])))]);
  const candidateIds = [...new Set(rows.flatMap((r) => (r.c.payload.candidates ?? []).map((x) => x.id)))];
  const candidateRows = new Map(
    (candidateIds.length
      ? await q
          .select()
          .from(transactions)
          .where(and(eq(transactions.userId, user.id), inArray(transactions.id, candidateIds)))
      : []
    ).map((t) => [t.id, t]),
  );
  const changed = rows.filter((r) => r.c.review === "amount_changed");
  const splits = await loadSplits(q, user.id, changed.map((r) => r.c.transactionId!));

  const items: ReviewItem[] = [];
  for (const { c, occurredOn, merchant, amountMinor, currency } of rows) {
    const capture: ReviewCapture = {
      kind: c.kind,
      transactionId: c.transactionId!,
      occurredAt: c.occurredAt,
      occurredOn,
      amountMinor: c.amountMinor,
      currency: c.currency,
      last4: c.last4,
      hold: c.hold,
      merchant,
    };
    let type: ReviewType;
    let stale: StaleReason | null = null;
    let shares: ReviewItem["shares"] = null;
    if (c.review === "amount_changed") {
      type = "amount_changed";
      const s = splits.get(c.transactionId!) ?? [];
      shares = { sharesMinor: s.reduce((a, x) => a + x.owedMinor, 0), amountMinor: Math.abs(amountMinor) };
      capture.amountMinor = amountMinor;
      capture.currency = currency;
    } else if (c.review) {
      type = c.review;
    } else {
      stale = staleReason(capture, reach, today);
      if (!stale) continue;
      type = "stale";
    }
    const candidates = (c.payload.candidates ?? []).flatMap((x): ReviewCandidate[] => {
      const t = candidateRows.get(x.id);
      if (!t || t.status !== "ok" || t.duplicateOfId != null) return [];
      return [
        {
          transactionId: t.id,
          source: t.source,
          occurredAt: t.occurredAt,
          occurredOn: t.occurredOn,
          amountMinor: t.amountMinor,
          currency: t.currency,
          merchant: t.merchant || t.counterpartyRaw,
          reasons: x.reasons as MatchReason[],
          daysAfter: dayDiff(occurredOn, t.occurredOn),
          amountDiffMinor: t.currency === c.currency ? Math.abs(t.amountMinor) - Math.abs(c.amountMinor) : 0,
        },
      ];
    });
    if ((type === "ambiguous" || type === "near_miss") && candidates.length === 0) continue;
    items.push({ captureId: c.id, type, capture, candidates, stale, shares, createdAt: c.createdAt });
  }
  items.sort((a, b) => REVIEW_TYPES.indexOf(a.type) - REVIEW_TYPES.indexOf(b.type));
  const counts = emptyCounts();
  for (const i of items) counts[i.type] += 1;
  return { items, counts, total: items.length };
}

export interface ResolveResult {
  captureIds: number[];
  /** The captures' states after the action. */
  states: CaptureState[];
}

function invalid(id: number, action: string): CaptureError {
  return new CaptureError("conflict", "capture_action_invalid", `"${action}" does not apply to capture #${id} now`, { id, action });
}

async function applyAction(q: Db, user: CurrentUser, c: CaptureRow, action: ReviewAction, candidateId?: number): Promise<void> {
  const by = "user";
  const choosing = c.state === "provisional" && (c.review === "ambiguous" || c.review === "near_miss");
  switch (action) {
    case "link": {
      if (!choosing) throw invalid(c.id, action);
      if (candidateId === undefined || !(c.payload.candidates ?? []).some((x) => x.id === candidateId)) {
        throw new CaptureError("conflict", "capture_candidate_invalid", `Transaction #${candidateId} is not a candidate of capture #${c.id}`, { id: c.id });
      }
      await supersede(q, user, c.id, candidateId, { by });
      return;
    }
    case "keep_separate": {
      if (!choosing) throw invalid(c.id, action);
      const rejected = [...new Set([...(c.payload.rejected ?? []), ...(c.payload.candidates ?? []).map((x) => x.id)])];
      await recordResolution(q, c, { action, state: "provisional", rejected, by });
      return;
    }
    case "keep_final":
    case "discard": {
      if (c.state !== "provisional") throw invalid(c.id, action);
      const row = await captureRow(q, user, c);
      const patch = action === "discard" ? { status: "closed" as const, provisional: null } : { provisional: null };
      await q.update(transactions).set(patch).where(eq(transactions.id, row.id));
      await recordResolution(q, c, {
        action,
        state: action === "discard" ? "discarded" : "confirmed",
        by,
        row: action === "discard" ? { status: row.status, provisional: row.provisional } : { provisional: row.provisional },
      });
      return;
    }
    case "keep_shares": {
      if (c.review !== "amount_changed") throw invalid(c.id, action);
      await recordResolution(q, c, { action, state: c.state, by });
      return;
    }
  }
}

/**
 * One review action, then the queue is refreshed. link (a candidate the item offers): the statement row supersedes or
 * confirms the capture. keep_separate: none of the offered rows is this charge; the capture stays provisional.
 * keep_final: the capture is the final record (no statement row will come). discard: its row is closed (not counted,
 * restorable). keep_shares: the exact split stays as it is. Every action can be undone (undoCapture).
 */
export async function resolveReview(db: Db, user: CurrentUser, captureId: number, body: { action: ReviewAction; candidateId?: number }): Promise<ResolveResult> {
  return await db.transaction(async (q) => {
    await applyAction(q, user, await getCapture(q, user, captureId), body.action, body.candidateId);
    await runMatching(q, user, { by: "user" });
    return { captureIds: [captureId], states: [(await getCapture(q, user, captureId)).state] };
  });
}

/** The same action on several items in one DB transaction (all or nothing). */
export async function resolveReviewBulk(db: Db, user: CurrentUser, body: { captureIds: number[]; action: BulkReviewAction }): Promise<ResolveResult> {
  return await db.transaction(async (q) => {
    for (const id of body.captureIds) await applyAction(q, user, await getCapture(q, user, id), body.action);
    await runMatching(q, user, { by: "user" });
    const states: CaptureState[] = [];
    for (const id of body.captureIds) states.push((await getCapture(q, user, id)).state);
    return { captureIds: body.captureIds, states };
  });
}

/** Takes back the capture's last resolution (the toast's Undo), then refreshes the queue. */
export async function undoCapture(db: Db, user: CurrentUser, captureId: number): Promise<ResolveResult> {
  return await db.transaction(async (q) => {
    const c = await undoResolution(q, user, captureId, { by: "user" });
    await runMatching(q, user, { by: "user" });
    return { captureIds: [captureId], states: [(await getCapture(q, user, c.id)).state] };
  });
}


/** Ids of captures a batch's rows confirmed or superseded (revertBatch takes those back first). */
export async function capturesConfirmedBy(q: Db, user: CurrentUser, authorityIds: readonly number[]): Promise<number[]> {
  if (authorityIds.length === 0) return [];
  return (
    await q
      .select({ id: captures.id })
      .from(captures)
      .where(and(eq(captures.userId, user.id), inArray(captures.authorityId, [...authorityIds]), inArray(captures.state, ["confirmed", "superseded"])))
  ).map((r) => r.id);
}
