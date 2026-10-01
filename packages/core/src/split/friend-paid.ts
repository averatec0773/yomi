import { randomUUID } from "node:crypto";
import { categories, transactions } from "@yomi/db";
import { and, eq } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { assertCurrency, getParticipant, type Q, SplitError, toOccurredAt } from "./internal";
import { setSplit, type SplitMode, type SplitView } from "./splits";

export interface FriendPaidInput {
  payerId: number;
  totalMinor: number;
  currency: string;
  /** 'YYYY-MM-DD' or a full ISO timestamp. */
  occurredAt: string;
  description: string;
  categoryId?: number | null;
  /** Non-self participants sharing with me; default [payerId]. */
  participantIds?: number[];
  mode?: SplitMode;
  exact?: { participantId: number; owedMinor: number }[];
}

export interface CreatedEntry {
  transactionId: number;
  split: SplitView | null;
  /** What counts toward my spending: my owed share, or the whole amount when unsplit. */
  myShareMinor: number;
}

export async function categoryIdByName(db: Q, user: CurrentUser, name: string | null | undefined): Promise<number | null> {
  const find = async (n: string) =>
    (await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, user.id), eq(categories.name, n)))
      .limit(1))[0]?.id ?? null;
  return (name ? await find(name) : null) ?? await find("其他");
}

export async function assertCategory(db: Q, user: CurrentUser, id: number): Promise<number> {
  const c = (await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, user.id), eq(categories.id, id)))
    .limit(1))[0];
  if (!c) throw new SplitError("not_found", "category_not_found", `Category ${id} does not exist`, { id });
  return c.id;
}

export function manualDedupKey(): string {
  return `manual:${randomUUID()}`;
}

/**
 * "The roommate paid for something": a transaction with no account of mine (account_id null), kind expense,
 * amount -total, and splits where the payer paid the total. Only my owed share is my spending.
 */
export async function createFriendPaidExpense(db: Q, user: CurrentUser, input: FriendPaidInput): Promise<CreatedEntry> {
  return await db.transaction(async (q) => {
    const payer = await getParticipant(q, user, input.payerId);
    if (payer.isSelf) throw new SplitError("invalid", "friend_paid_payer_is_self", "When I paid, record it as a normal expense");
    if (!Number.isSafeInteger(input.totalMinor) || input.totalMinor <= 0) {
      throw new SplitError("invalid", "amount_not_positive", "The amount must be a positive integer (minor units)");
    }
    const description = input.description.trim();
    const categoryId =
      input.categoryId != null ? await assertCategory(q, user, input.categoryId) : await categoryIdByName(q, user, null);
    const row = (await q
      .insert(transactions)
      .values({
        userId: user.id,
        accountId: null,
        occurredAt: toOccurredAt(input.occurredAt),
        amountMinor: -input.totalMinor,
        currency: assertCurrency(input.currency),
        kind: "expense",
        counterpartyRaw: payer.name,
        descriptionRaw: description,
        merchant: description,
        categoryId,
        source: "manual",
        dedupKey: manualDedupKey(),
      })
      .returning({ id: transactions.id })
      )[0]!;
    const split = await setSplit(q, user, row.id, {
      participantIds: input.participantIds ?? [payer.id],
      mode: input.mode ?? "equal",
      exact: input.exact,
      payerId: payer.id,
    });
    return { transactionId: row.id, split, myShareMinor: split?.myShareMinor ?? input.totalMinor };
  });
}
