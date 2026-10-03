import { type CaptureKind, type CaptureReview, captures, type CaptureState, type Db, transactions } from "@yomi/db";
import type { NormalizedRow } from "@yomi/importers";
import { and, eq } from "@yomi/db/orm";
import { ensureAccount, resolveAccountSpec } from "../import/accounts";
import { resolveCategoryId } from "../import/categorize";
import { categoryContext, latestPurchaseCategories, loadCategorySources } from "../import/category-context";
import { cleanMerchant } from "../import/merchant";
import { myShareMinor } from "../ledger/share";
import { getTimeZone } from "../settings/time-zone";
import { autoSplitParticipants } from "../split/rules";
import { applySplit, getSplit, setSplit, type SplitMode, type SplitView } from "../split/splits";
import { occurredOnFor } from "../time/zone";
import type { CurrentUser } from "../user";
import { runMatching } from "./match";

export interface CaptureInput {
  kind: CaptureKind;
  /** The charge as the capture reads it, shaped like an imported statement row (account, category and merchant come from it). */
  row: NormalizedRow;
  /** Unique per user: the same capture sent twice finds the first one and writes nothing. */
  dedupKey: string;
  /** A card hold (pre-authorisation): marked, not counted, never auto-split. */
  hold: boolean;
  /** Card last four the matcher compares with statement rows, when the capture names one. */
  last4: string | null;
  /** The captured text, kept while the capture is provisional. */
  text?: string;
  /** Non-self participants to split with (expenses only); without them the merchant's auto-split rule applies. */
  participantIds?: number[];
  mode?: SplitMode;
}

export interface CaptureResult {
  transactionId: number;
  split: SplitView | null;
  myShareMinor: number;
  /** The same capture was sent before; nothing was written. */
  alreadyAdded: boolean;
  /** The statement (or wallet) row this capture duplicates; the new row is kept but not counted. */
  duplicateOfId: number | null;
  captureId: number;
  /** provisional until a statement row supersedes (or, for a split row, confirms) it. */
  state: CaptureState;
  /** An open review the capture landed in (two statement rows fit it, or one nearly does). */
  review: CaptureReview | null;
}

async function categoryFor(q: Db, user: CurrentUser, row: NormalizedRow, merchant: string): Promise<number | null> {
  // resolveCategoryId is synchronous: a refund's purchase category is looked up first.
  const inherited = row.kind === "refund" ? await latestPurchaseCategories(q, user, [merchant]) : new Map<string, number | null>();
  return resolveCategoryId(row, merchant, categoryContext(await loadCategorySources(q, user), (m) => inherited.get(m) ?? null));
}

/**
 * Saves a capture (a pasted card SMS today; screenshot, agent and manual proposals later) as a provisional
 * transaction on the account its row names, with its capture row. Idempotent by dedup key. Participants split it like
 * quick add; without them the merchant's auto-split rule applies. Then the matcher runs: when exactly one statement
 * (or Alipay/WeChat) row already in the ledger is this charge, it supersedes the capture at once (a split capture
 * stays primary and takes the statement's facts); ties and near misses go to the review queue.
 */
export async function createCapture(db: Db, user: CurrentUser, input: CaptureInput): Promise<CaptureResult> {
  const { row, dedupKey } = input;
  return await db.transaction(async (q) => {
    const existing = (await q
      .select({ id: captures.id, transactionId: transactions.id, duplicateOfId: transactions.duplicateOfId, state: captures.state, review: captures.review })
      .from(captures)
      .innerJoin(transactions, eq(transactions.id, captures.transactionId))
      .where(and(eq(captures.userId, user.id), eq(captures.dedupKey, dedupKey)))
      .limit(1))[0];
    if (existing) {
      const { id: captureId, ...rest } = existing;
      return { ...rest, captureId, split: null, myShareMinor: 0, alreadyAdded: true };
    }

    const merchant = cleanMerchant(row.counterparty);
    const inserted = (await q
      .insert(transactions)
      .values({
        userId: user.id,
        accountId: await ensureAccount(q, user, resolveAccountSpec(row, row.currency)),
        occurredAt: row.occurredAt,
        occurredOn: occurredOnFor(row.occurredAt, row.source, await getTimeZone(q, user)),
        amountMinor: row.amountMinor,
        currency: row.currency,
        kind: row.kind,
        counterpartyRaw: row.counterparty,
        descriptionRaw: row.description,
        merchant,
        categoryId: await categoryFor(q, user, row, merchant),
        source: row.source,
        sourceCategory: row.sourceCategory,
        paymentMethod: row.paymentMethod,
        raw: row.raw,
        dedupKey,
        status: "ok",
        provisional: input.hold ? "hold" : "capture",
      })
      .returning({ id: transactions.id })
      )[0]!;
    const captureId = (await q
      .insert(captures)
      .values({
        userId: user.id,
        kind: input.kind,
        state: "provisional",
        dedupKey,
        transactionId: inserted.id,
        occurredAt: row.occurredAt,
        amountMinor: row.amountMinor,
        currency: row.currency,
        last4: input.last4,
        hold: input.hold,
        payload: { v: 1, text: input.text, history: [{ at: new Date().toISOString(), from: null, to: "provisional", by: "user" }] },
      })
      .returning({ id: captures.id }))[0]!.id;

    // Split first: a split capture is the user's record, so a statement row found next confirms it instead of replacing it.
    let split: SplitView | null = null;
    if (row.kind === "expense") {
      const others = input.participantIds ?? [];
      if (others.length > 0) {
        split = await setSplit(q, user, inserted.id, { participantIds: others, mode: input.mode ?? "equal" });
      } else if (!input.hold) {
        // A hold's amount is not final yet: no automatic split.
        const auto = merchant ? (await autoSplitParticipants(q, user)).get(merchant) : undefined;
        if (auto) split = await applySplit(q, user, inserted.id, { participantIds: auto, mode: "equal" }, { markEdited: false, rememberMerchant: false });
      }
    }
    await runMatching(q, user, { by: "user", newCaptureIds: [captureId] });

    const after = (await q.select().from(transactions).where(eq(transactions.id, inserted.id)).limit(1))[0]!;
    const capture = (await q.select({ state: captures.state, review: captures.review }).from(captures).where(eq(captures.id, captureId)).limit(1))[0]!;
    if (split) split = await getSplit(q, user, inserted.id);
    return {
      transactionId: inserted.id,
      split,
      myShareMinor: myShareMinor(after, split?.rows ?? []),
      alreadyAdded: false,
      duplicateOfId: after.duplicateOfId,
      captureId,
      state: capture.state,
      review: capture.review,
    };
  });
}
