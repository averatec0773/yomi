import { accounts, categories, type Db, settlements, transactions, transactionSplits } from "@yomi/db";
import { and, eq, inArray } from "@yomi/db/orm";
import { applyOwnTransfer, detectOwnTransfers, revertOwnTransfer, type TransferProposal } from "../import/transfers";
import { LedgerError } from "../ledger/errors";
import type { TransactionKind } from "../ledger/transactions";
import { markAsSettlement } from "../split/candidates";
import { type RepaymentProposal, repaymentProposals } from "../split/repayments";
import type { CurrentUser } from "../user";

// Review items about rows already in the ledger (AA repayments, own-account transfers), derived when the queue is read
// and never stored, and the actions on them. Captures keep their own items and actions (review.ts).

/** The ledger row an item is about, as the review sheet shows it. */
export interface ReviewRow {
  transactionId: number;
  occurredAt: string;
  occurredOn: string;
  amountMinor: number;
  currency: string;
  kind: TransactionKind;
  source: string;
  merchant: string;
  accountName: string | null;
  categoryId: number | null;
}

export interface OwnTransferItem {
  subject: "transaction";
  type: "own_transfer";
  transactionId: number;
  row: ReviewRow;
  /** The other leg, when it is in the ledger. */
  peer: ReviewRow | null;
  proposal: Omit<TransferProposal, "transactionId">;
}

export interface RepaymentReviewItem {
  subject: "transaction";
  type: "repayment";
  transactionId: number;
  row: ReviewRow;
  proposal: RepaymentProposal;
}

export type TransactionReviewItem = RepaymentReviewItem | OwnTransferItem;

/** The fields of the item's row an action changes; returned so Undo can put them back. */
export interface ReviewPrior {
  kind: TransactionKind;
  categoryId: number | null;
  userEditedAt: string | null;
  reviewDismissedAt: string | null;
}

/**
 * settle: the row is this repayment (a settlement with `participantId`, paying `itemTransactionIds`, for `amountMinor`
 * in `currency` when given; Undo deletes the settlement). own_transfer: the proposal is right (the row and its peer
 * become transfers). income: the row is income in this category (`categoryId`) and is not proposed again. dismiss: not
 * a repayment or transfer, never proposed again.
 */
export type TransactionReviewAction = "settle" | "own_transfer" | "income" | "dismiss";

export interface TransactionReviewBody {
  action: TransactionReviewAction;
  participantId?: number;
  itemTransactionIds?: number[];
  amountMinor?: number;
  currency?: string;
  categoryId?: number;
}

export interface TransactionReviewResult {
  transactionId: number;
  /** The row's kind after the action. */
  kind: TransactionKind;
  prior: ReviewPrior;
  /** settle: the settlement recorded (Undo deletes it). */
  settlementId: number | null;
}

async function reviewRows(q: Db, user: CurrentUser, ids: readonly number[]): Promise<Map<number, ReviewRow>> {
  if (ids.length === 0) return new Map();
  const rows = await q
    .select({
      transactionId: transactions.id,
      occurredAt: transactions.occurredAt,
      occurredOn: transactions.occurredOn,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      kind: transactions.kind,
      source: transactions.source,
      merchant: transactions.merchant,
      counterparty: transactions.counterpartyRaw,
      accountName: accounts.name,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .leftJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(eq(transactions.userId, user.id), inArray(transactions.id, [...ids])));
  return new Map(rows.map(({ counterparty, ...r }) => [r.transactionId, { ...r, merchant: r.merchant || counterparty }]));
}

/** Both kinds of proposal; a row proposed as my own transfer is not also offered as a repayment. */
async function proposals(q: Db, user: CurrentUser, opts: { today?: string }) {
  const transfers = await detectOwnTransfers(q, user);
  const mine = new Set(transfers.flatMap((p) => (p.peerId == null ? [p.transactionId] : [p.transactionId, p.peerId])));
  const repayments = (await repaymentProposals(q, user, opts)).filter((r) => !mine.has(r.transactionId));
  return { transfers, repayments };
}

/**
 * Repayment and own-account transfer proposals as review items, repayments best first, transfers newest first (every
 * confidence: history is only ever changed by the user).
 */
export async function transactionReviewItems(q: Db, user: CurrentUser, opts: { today?: string } = {}): Promise<TransactionReviewItem[]> {
  const { transfers, repayments } = await proposals(q, user, opts);
  const rows = await reviewRows(q, user, [...transfers.flatMap((p) => (p.peerId == null ? [p.transactionId] : [p.transactionId, p.peerId])), ...repayments.map((r) => r.transactionId)]);
  const own = transfers
    .map(({ transactionId, ...proposal }): OwnTransferItem => ({
      subject: "transaction",
      type: "own_transfer",
      transactionId,
      row: rows.get(transactionId)!,
      peer: proposal.peerId == null ? null : rows.get(proposal.peerId)!,
      proposal,
    }))
    .sort((a, b) => b.row.occurredOn.localeCompare(a.row.occurredOn) || b.transactionId - a.transactionId);
  const paid = repayments.map(({ transactionId, proposal }): RepaymentReviewItem => ({ subject: "transaction", type: "repayment", transactionId, row: rows.get(transactionId)!, proposal }));
  return [...paid, ...own];
}

/** transactionReviewItems' length without loading the rows. */
export async function countTransactionReview(q: Db, user: CurrentUser, opts: { today?: string } = {}): Promise<number> {
  const { transfers, repayments } = await proposals(q, user, opts);
  return transfers.length + repayments.length;
}

async function openRow(q: Db, user: CurrentUser, id: number) {
  const r = (await q.select().from(transactions).where(and(eq(transactions.userId, user.id), eq(transactions.id, id))).limit(1))[0];
  if (!r) throw new LedgerError("not_found", "transaction_not_found", `Transaction #${id} does not exist`, { id });
  if (r.status !== "ok" || r.duplicateOfId != null) throw new LedgerError("conflict", "review_item_gone", `Transaction #${id} has nothing to review now`, { id });
  return r;
}

async function assertUnlocked(q: Db, user: CurrentUser, id: number): Promise<void> {
  const split = (await q.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.transactionId, id)).limit(1))[0];
  const settled = (await q.select({ id: settlements.id }).from(settlements).where(and(eq(settlements.userId, user.id), eq(settlements.transactionId, id))).limit(1))[0];
  if (split || settled) throw new LedgerError("conflict", "review_item_gone", `Transaction #${id} has nothing to review now`, { id });
}

const priorOf = (r: ReviewPrior): ReviewPrior => ({ kind: r.kind, categoryId: r.categoryId, userEditedAt: r.userEditedAt, reviewDismissedAt: r.reviewDismissedAt });

async function applyAction(q: Db, user: CurrentUser, id: number, body: TransactionReviewBody, proposals: readonly TransferProposal[]): Promise<TransactionReviewResult> {
  const row = await openRow(q, user, id);
  const prior = priorOf(row);
  const now = new Date().toISOString();
  switch (body.action) {
    case "settle": {
      if (body.participantId === undefined) throw new LedgerError("invalid", "review_settle_participant", "Pick who paid you back");
      const s = await markAsSettlement(q, user, id, {
        participantId: body.participantId,
        amountMinor: body.amountMinor,
        currency: body.currency,
        itemTransactionIds: body.itemTransactionIds,
      });
      return { transactionId: id, kind: row.kind === "income" || row.kind === "expense" ? "transfer" : row.kind, prior, settlementId: s.id };
    }
    case "own_transfer": {
      const p = proposals.find((x) => x.transactionId === id);
      if (!p) throw new LedgerError("conflict", "review_item_gone", `Transaction #${id} has nothing to review now`, { id });
      await applyOwnTransfer(q, user, p, { by: "user" });
      return { transactionId: id, kind: "transfer", prior, settlementId: null };
    }
    case "income": {
      const cat = body.categoryId === undefined ? undefined : (await q.select().from(categories).where(and(eq(categories.userId, user.id), eq(categories.id, body.categoryId))).limit(1))[0];
      if (!cat || cat.kind !== "income") throw new LedgerError("invalid", "review_income_category", "Pick an income category", { id: body.categoryId ?? 0 });
      await assertUnlocked(q, user, id);
      if (row.kindRule != null) await revertOwnTransfer(q, user, id, { dismiss: true });
      await q
        .update(transactions)
        .set({ kind: "income", categoryId: cat.id, userEditedAt: now, reviewDismissedAt: now, updatedAt: now })
        .where(eq(transactions.id, id));
      return { transactionId: id, kind: "income", prior, settlementId: null };
    }
    case "dismiss": {
      if (row.kindRule != null) {
        await revertOwnTransfer(q, user, id, { dismiss: true });
        return { transactionId: id, kind: row.priorKind ?? row.kind, prior, settlementId: null };
      }
      await q.update(transactions).set({ reviewDismissedAt: now, updatedAt: now }).where(eq(transactions.id, id));
      return { transactionId: id, kind: row.kind, prior, settlementId: null };
    }
  }
}

/** One action on a transaction review item (see TransactionReviewAction); Undo is undoTransactionReview. */
export async function resolveTransactionReview(db: Db, user: CurrentUser, id: number, body: TransactionReviewBody): Promise<TransactionReviewResult> {
  return await db.transaction(async (q) => await applyAction(q, user, id, body, body.action === "own_transfer" ? await detectOwnTransfers(q, user, { ids: [id] }) : []));
}

/** Confirms several own-account transfer items in one DB transaction (all or nothing). */
export async function confirmOwnTransfers(db: Db, user: CurrentUser, ids: readonly number[]): Promise<TransactionReviewResult[]> {
  return await db.transaction(async (q) => {
    const proposals = await detectOwnTransfers(q, user, { ids });
    const out: TransactionReviewResult[] = [];
    for (const id of ids) out.push(await applyAction(q, user, id, { action: "own_transfer" }, proposals));
    return out;
  });
}

/**
 * Takes an action back (the toast's Undo). own_transfer: the row and its peer get their prior kinds back and return to
 * the queue. income and dismiss: the row's kind, category, edit mark and dismissal return to `prior` (as the action
 * returned it). A settlement is taken back by deleting it (deleteSettlement).
 */
export async function undoTransactionReview(
  db: Db,
  user: CurrentUser,
  id: number,
  body: { action: Exclude<TransactionReviewAction, "settle">; prior: ReviewPrior },
): Promise<TransactionReviewResult> {
  return await db.transaction(async (q) => {
    const row = await openRow(q, user, id);
    if (body.action === "own_transfer") {
      await revertOwnTransfer(q, user, id, { dismiss: false });
    } else {
      const { categoryId } = body.prior;
      if (categoryId != null && !(await q.select({ id: categories.id }).from(categories).where(and(eq(categories.userId, user.id), eq(categories.id, categoryId))).limit(1))[0]) {
        throw new LedgerError("invalid", "category_not_found", `Category #${categoryId} does not exist`, { id: categoryId });
      }
      await q.update(transactions).set({ ...body.prior, updatedAt: new Date().toISOString() }).where(eq(transactions.id, row.id));
    }
    const after = await openRow(q, user, id);
    return { transactionId: id, kind: after.kind, prior: priorOf(row), settlementId: null };
  });
}
