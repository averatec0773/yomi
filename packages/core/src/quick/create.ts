import { accounts, transactions } from "@yomi/db";
import { and, eq } from "@yomi/db/orm";
import { categoryIdByName, type CreatedEntry, createFriendPaidExpense, manualDedupKey } from "../split/friend-paid";
import { assertCurrency, assertDate, getSelf, type Q, SplitError, toOccurredAt } from "../split/internal";
import { setSplit, type SplitMode } from "../split/splits";
import type { CurrentUser } from "../user";

export const MANUAL_ACCOUNT_NAME = "手动记账";

export interface QuickEntryInput {
  amountMinor: number;
  currency: string;
  description: string;
  date: string;
  participantIds: number[];
  payerId: number | null;
  mode: SplitMode;
  categoryHint: string | null;
}

async function manualAccountId(db: Q, user: CurrentUser, currency: string): Promise<number> {
  const found = (await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.kind, "cash"), eq(accounts.name, MANUAL_ACCOUNT_NAME)))
    .limit(1))[0];
  if (found) return found.id;
  return (await db
    .insert(accounts)
    .values({ userId: user.id, name: MANUAL_ACCOUNT_NAME, kind: "cash", currency })
    .returning({ id: accounts.id })
    )[0]!.id;
}

/**
 * Saves a quick-entry draft. I paid → a manual expense on the auto-created "手动记账" cash account
 * (plus splits when participants are given). A friend paid → createFriendPaidExpense.
 */
export async function createQuickEntry(db: Q, user: CurrentUser, draft: QuickEntryInput): Promise<CreatedEntry> {
  if (!Number.isSafeInteger(draft.amountMinor) || draft.amountMinor <= 0) {
    throw new SplitError("invalid", "amount_not_positive", "The amount must be a positive integer (minor units)");
  }
  const currency = assertCurrency(draft.currency);
  const date = assertDate(draft.date);
  const description = draft.description.trim();
  return await db.transaction(async (q) => {
    const self = await getSelf(q, user);
    const categoryId = await categoryIdByName(q, user, draft.categoryHint);
    if (draft.payerId !== null && draft.payerId !== self.id) {
      return await createFriendPaidExpense(q, user, {
        payerId: draft.payerId,
        totalMinor: draft.amountMinor,
        currency,
        occurredAt: date,
        description,
        categoryId,
        participantIds: draft.participantIds,
        mode: draft.mode === "full" ? "equal" : draft.mode,
      });
    }
    const row = (await q
      .insert(transactions)
      .values({
        userId: user.id,
        accountId: await manualAccountId(q, user, currency),
        occurredAt: toOccurredAt(date),
        occurredOn: date,
        amountMinor: -draft.amountMinor,
        currency,
        kind: "expense",
        descriptionRaw: description,
        merchant: description,
        categoryId,
        source: "manual",
        dedupKey: manualDedupKey(),
      })
      .returning({ id: transactions.id })
      )[0]!;
    const others = draft.participantIds.filter((id) => id !== self.id);
    const split = others.length > 0 ? await setSplit(q, user, row.id, { participantIds: others, mode: draft.mode }) : null;
    return { transactionId: row.id, split, myShareMinor: split?.myShareMinor ?? draft.amountMinor };
  });
}
