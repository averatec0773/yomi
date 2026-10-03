import { merchantRules, participants, transactions, transactionSplits, type Db } from "@yomi/db";
import { and, eq, inArray } from "@yomi/db/orm";
import { formatMinor, splitEqual } from "../money";
import type { CurrentUser } from "../user";
import { getSelf, getTransaction, nowIso, SplitError, type TransactionRow } from "./internal";

export type SplitMode = "equal" | "full" | "exact";

export interface SetSplitInput {
  /** Non-self participants on the row. "我" is always implicit and ignored if listed. */
  participantIds: number[];
  mode: SplitMode;
  /** For mode exact: owed totals (always >= 0, even for refunds). "我" may be listed; unlisted "我" gets the rest. */
  exact?: { participantId: number; owedMinor: number }[];
  /** Who paid the whole amount; default "我". Someone else only for rows with account_id null (friend-paid). */
  payerId?: number;
}

export interface SplitRowView {
  participantId: number;
  name: string;
  isSelf: boolean;
  owedMinor: number;
  paidMinor: number;
}

export interface SplitView {
  transactionId: number;
  currency: string;
  /** |amount|; owed/paid are totals too (a refund's direction comes from the transaction). */
  totalMinor: number;
  mode: SplitMode;
  payerId: number;
  /** Non-self participants sharing the row (a friend payer with owed 0 is not listed). */
  participantIds: number[];
  myShareMinor: number;
  rows: SplitRowView[];
}

const SPLITTABLE: ReadonlySet<TransactionRow["kind"]> = new Set(["expense", "refund"]);

/**
 * Split amounts are magnitudes of the transaction's |amount|, whatever its sign. A refund of a
 * shared purchase is split the same way; its direction comes from the transaction (amount > 0),
 * so balances subtract it and spending treats my share as negative (see ledger/share.ts).
 */
function splitTotal(t: TransactionRow): number {
  return Math.abs(t.amountMinor);
}

export async function getSplit(db: Db, user: CurrentUser, txId: number): Promise<SplitView | null> {
  const t = await getTransaction(db, user, txId);
  const self = await getSelf(db, user);
  const rows = await db
    .select({
      participantId: transactionSplits.participantId,
      name: participants.name,
      isSelf: participants.isSelf,
      owedMinor: transactionSplits.owedMinor,
      paidMinor: transactionSplits.paidMinor,
      method: transactionSplits.method,
    })
    .from(transactionSplits)
    .innerJoin(participants, eq(participants.id, transactionSplits.participantId))
    .where(and(eq(transactionSplits.userId, user.id), eq(transactionSplits.transactionId, txId)))
    .orderBy(transactionSplits.id);
  if (rows.length === 0) return null;
  const total = splitTotal(t);
  const payer = rows.find((r) => r.paidMinor !== 0) ?? rows.find((r) => r.isSelf);
  const payerId = payer?.participantId ?? self.id;
  const me = rows.find((r) => r.isSelf);
  const myShare = me?.owedMinor ?? 0;
  let mode: SplitMode = "exact";
  if (rows.every((r) => r.method === "equal")) mode = "equal";
  else if (payerId === self.id && myShare === 0) mode = "full";
  const participantIds = rows
    .filter((r) => !r.isSelf && !(r.participantId === payerId && r.owedMinor === 0))
    .map((r) => r.participantId);
  return {
    transactionId: txId,
    currency: t.currency,
    totalMinor: total,
    mode,
    payerId,
    participantIds,
    myShareMinor: myShare,
    rows: rows.map(({ method: _m, ...r }) => r),
  };
}

function uniq(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

async function assertParticipantsExist(db: Db, user: CurrentUser, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.userId, user.id), inArray(participants.id, [...ids])));
  const have = new Set(found.map((f) => f.id));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) throw new SplitError("not_found", "participant_not_found", `Participant not found: ${missing.join(", ")}`, { ids: missing.join(", ") });
}

async function writeMerchantRule(db: Db, user: CurrentUser, merchant: string, ids: number[] | null): Promise<void> {
  if (!merchant) return;
  // An auto-split rule is an explicit choice: a one-off split of the same merchant does not rewrite it.
  const current = (await db
    .select({ autoSplit: merchantRules.autoSplit })
    .from(merchantRules)
    .where(and(eq(merchantRules.userId, user.id), eq(merchantRules.merchant, merchant)))
    .limit(1))[0];
  if (current?.autoSplit) return;
  const value = ids && ids.length > 0 ? [...ids].sort((a, b) => a - b) : null;
  if (value === null) {
    await db.update(merchantRules)
      .set({ participantIds: null })
      .where(and(eq(merchantRules.userId, user.id), eq(merchantRules.merchant, merchant)));
    return;
  }
  // Only participant_ids: category_id on the same row belongs to the categorization code.
  await db.insert(merchantRules)
    .values({ userId: user.id, merchant, participantIds: value })
    .onConflictDoUpdate({ target: [merchantRules.userId, merchantRules.merchant], set: { participantIds: value } });
}

/**
 * Replaces the row's splits. Empty participantIds with "我" as payer clears them. Also sets
 * user_edited_at and remembers the participants for the row's merchant.
 *
 * Star model: my ledger only tracks debts between me and each other person. When a friend paid
 * (payerId is not "我"), shares are computed over everyone listed (equal/exact, remainder to me as
 * usual), but only two rows are stored: me (owed = my share, paid 0) and the payer (owed = total −
 * my share, paid = total). Third parties are not stored: what they owe the payer is not my debt.
 * So "B paid ¥90 for me, A and B" leaves me owing B ¥30 and nothing between me and A.
 */
export async function setSplit(db: Db, user: CurrentUser, txId: number, input: SetSplitInput): Promise<SplitView | null> {
  return await applySplit(db, user, txId, input, { markEdited: true, rememberMerchant: true });
}

export interface ApplySplitOptions {
  /** Set user_edited_at (a user action). Import auto-split leaves it null so reverting the batch removes the rows. */
  markEdited: boolean;
  /** Remember the participants in merchant_rules (the chip suggestion for the next row). */
  rememberMerchant: boolean;
}

/** setSplit's single code path; auto-split (import, apply-to-existing) calls it with its own options. */
export async function applySplit(
  db: Db,
  user: CurrentUser,
  txId: number,
  input: SetSplitInput,
  opts: ApplySplitOptions,
): Promise<SplitView | null> {
  return await db.transaction(async (q) => {
    const t = await getTransaction(q, user, txId);
    if (!SPLITTABLE.has(t.kind)) throw new SplitError("invalid", "split_kind_not_splittable", "Only expenses (or refunds of a shared expense) can be split");
    if (t.status !== "ok" || t.duplicateOfId !== null) throw new SplitError("invalid", "split_closed_or_duplicate", "A closed or duplicate transaction cannot be split");
    const self = await getSelf(q, user);
    const payerId = input.payerId ?? self.id;
    const exact = input.mode === "exact" ? (input.exact ?? []) : [];
    const others = uniq([...input.participantIds, ...exact.map((e) => e.participantId)]).filter((id) => id !== self.id);
    await assertParticipantsExist(q, user, uniq([payerId, ...others]));
    if (payerId !== self.id && t.accountId !== null) {
      throw new SplitError("invalid", "split_payer_must_be_self", "A transaction paid from my own account can only have me as the payer");
    }

    const now = nowIso();
    await q.delete(transactionSplits)
      .where(and(eq(transactionSplits.userId, user.id), eq(transactionSplits.transactionId, txId)));

    if (others.length === 0 && payerId === self.id) {
      if (opts.markEdited) await q.update(transactions).set({ userEditedAt: now }).where(eq(transactions.id, txId));
      if (opts.rememberMerchant) await writeMerchantRule(q, user, t.merchant, null);
      return null;
    }

    const total = splitTotal(t);
    const owed = new Map<number, number>();

    if (input.mode === "equal") {
      const group = [self.id, ...others];
      splitEqual(total, group.length).forEach((share, i) => owed.set(group[i]!, share));
    } else if (input.mode === "full") {
      if (payerId !== self.id) throw new SplitError("invalid", "split_full_needs_self_payer", "\"They pay all\" only works for transactions I paid");
      if (others.length === 0) throw new SplitError("invalid", "split_full_needs_participant", "\"They pay all\" needs at least one person");
      owed.set(self.id, 0);
      splitEqual(total, others.length).forEach((share, i) => owed.set(others[i]!, share));
    } else {
      const given = new Map<number, number>();
      for (const e of exact) {
        if (!Number.isSafeInteger(e.owedMinor) || e.owedMinor < 0) {
          throw new SplitError("invalid", "split_exact_amount_invalid", "Split amounts must be non-negative integers (minor units)");
        }
        given.set(e.participantId, (given.get(e.participantId) ?? 0) + e.owedMinor);
      }
      const sum = [...given.values()].reduce((a, b) => a + b, 0);
      if (sum > total) throw new SplitError("invalid", "split_exact_over_total", `The split amounts add up to ${sum}, more than the total ${total}`, {
          sum: formatMinor(sum, t.currency),
          total: formatMinor(total, t.currency),
        });
      if (given.has(self.id) && sum !== total) {
        throw new SplitError("invalid", "split_exact_not_total", `The split amounts add up to ${sum}, not the total ${total}`, {
          sum: formatMinor(sum, t.currency),
          total: formatMinor(total, t.currency),
        });
      }
      owed.set(self.id, given.get(self.id) ?? total - sum);
      for (const id of others) owed.set(id, 0);
      for (const [id, v] of given) if (id !== self.id) owed.set(id, v);
    }

    let method: "equal" | "exact" = input.mode === "equal" ? "equal" : "exact";
    let stored: [number, number][];
    if (payerId === self.id) {
      stored = [...owed];
    } else {
      // Friend paid: keep only me and the payer (see the star-model note above).
      const mine = owed.get(self.id) ?? 0;
      stored = [
        [self.id, mine],
        [payerId, total - mine],
      ];
      // "equal" only when the two stored shares really are the equal split of me + payer.
      if (method === "equal" && others.some((id) => id !== payerId)) method = "exact";
    }
    if (!stored.some(([id]) => id === payerId)) stored.push([payerId, 0]);

    await q.insert(transactionSplits)
      .values(
        stored.map(([participantId, owedMinor]) => ({
          userId: user.id,
          transactionId: txId,
          participantId,
          currency: t.currency,
          owedMinor,
          paidMinor: participantId === payerId ? total : 0,
          method,
        })),
      );
    if (opts.markEdited) await q.update(transactions).set({ userEditedAt: now }).where(eq(transactions.id, txId));
    if (opts.rememberMerchant) await writeMerchantRule(q, user, t.merchant, others);
    return await getSplit(q, user, txId);
  });
}

export const FRIEND_PAID_TOGGLE_MESSAGE =
  "A friend-paid bill only records the shares between you and the payer; edit the whole row to change who shares it";

export interface ToggleResult {
  split: SplitView | null;
  /** The row was split by amount (exact) and the chip re-split it equally. */
  resetExact: boolean;
}

/**
 * The one-tap chip. No split yet → equal split with me + p. p already sharing → remove p (clears
 * when nobody else is left and I paid). Otherwise add p and re-split equally ("full" stays full;
 * an exact split becomes equal and `resetExact` says so). Friend-paid rows refuse chips: they only
 * hold me and the payer, so adding a third person or dropping the payer needs a full re-edit.
 */
export async function toggleParticipantResult(db: Db, user: CurrentUser, txId: number, participantId: number): Promise<ToggleResult> {
  return await db.transaction(async (q) => {
    const current = await getSplit(q, user, txId);
    const self = await getSelf(q, user);
    if (participantId === self.id) throw new SplitError("invalid", "split_self_toggle", "\"Me\" is always in the split");
    if (!current) return { split: await setSplit(q, user, txId, { participantIds: [participantId], mode: "equal" }), resetExact: false };
    if (current.payerId !== self.id) throw new SplitError("invalid", "split_friend_paid_third_party", FRIEND_PAID_TOGGLE_MESSAGE);
    const mode: SplitMode = current.mode === "full" ? "full" : "equal";
    const ids = current.participantIds.includes(participantId)
      ? current.participantIds.filter((id) => id !== participantId)
      : [...current.participantIds, participantId];
    if (ids.length === 0) return { split: await setSplit(q, user, txId, { participantIds: [], mode: "equal" }), resetExact: false };
    return { split: await setSplit(q, user, txId, { participantIds: ids, mode }), resetExact: current.mode === "exact" };
  });
}

export async function toggleParticipant(db: Db, user: CurrentUser, txId: number, participantId: number): Promise<SplitView | null> {
  return (await toggleParticipantResult(db, user, txId, participantId)).split;
}

export interface BulkToggleResult {
  updated: number[];
  unchanged: number[];
  /** `code` is the SplitError code, `reason` its English message. */
  skipped: { transactionId: number; code: string; reason: string }[];
}

/** Multi-select chip: turn p on (or off) for every row; rows that cannot be split are reported, not fatal. */
export async function bulkToggle(
  db: Db,
  user: CurrentUser,
  txIds: readonly number[],
  participantId: number,
  on: boolean,
): Promise<BulkToggleResult> {
  return await db.transaction(async (q) => {
    if (participantId === (await getSelf(q, user)).id) throw new SplitError("invalid", "split_self_toggle", "\"Me\" is always in the split");
    await assertParticipantsExist(q, user, [participantId]);
    const out: BulkToggleResult = { updated: [], unchanged: [], skipped: [] };
    for (const id of uniq(txIds)) {
      try {
        const current = await getSplit(q, user, id);
        const has = current?.participantIds.includes(participantId) ?? false;
        if (has === on) {
          out.unchanged.push(id);
          continue;
        }
        await toggleParticipant(q, user, id, participantId);
        out.updated.push(id);
      } catch (e) {
        if (!(e instanceof SplitError)) throw e;
        out.skipped.push({ transactionId: id, code: e.code, reason: e.message });
      }
    }
    return out;
  });
}
