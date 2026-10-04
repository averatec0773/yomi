import { accounts, categories, type Db, transactions } from "@yomi/db";
import { and, asc, eq } from "@yomi/db/orm";
import { LedgerError } from "../ledger/errors";
import { manualDedupKey } from "../split/friend-paid";
import { assertCurrency, assertDate, SplitError, toOccurredAt } from "../split/internal";
import type { CurrentUser } from "../user";
import { manualAccountId } from "./create";

/** Statement term the rows of a typed transfer carry (the UI shows it as "Transfer"). */
const TRANSFER_TERM = "转账";

export interface QuickAccount {
  id: number;
  name: string;
  currency: string;
}

export interface IncomeEntryInput {
  amountMinor: number;
  currency: string;
  /** An income category. */
  categoryId: number;
  date: string;
  /** The account the money arrived in; null books it on the manual cash account. */
  accountId: number | null;
  /** What it was ("Paycheck"): the row's merchant and description, like a quick expense's text. */
  note: string | null;
}

export interface TransferEntryInput {
  fromAccountId: number;
  toAccountId: number;
  amountMinor: number;
  date: string;
}

function assertAmount(minor: number): void {
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new SplitError("invalid", "amount_not_positive", "The amount must be a positive integer (minor units)");
  }
}

async function accountOf(db: Db, user: CurrentUser, id: number): Promise<QuickAccount> {
  const a = (await db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.id, id)))
    .limit(1))[0];
  if (!a) throw new LedgerError("not_found", "quick_account_not_found", `Account #${id} does not exist`, { id });
  return a;
}

/** My accounts, for the quick-add income and transfer forms. */
export async function quickAccounts(db: Db, user: CurrentUser): Promise<QuickAccount[]> {
  return await db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.userId, user.id))
    .orderBy(asc(accounts.id));
}

/** Income typed by hand: one manual income row in an income category, on the chosen account (its currency) or the manual cash account. */
export async function createIncomeEntry(db: Db, user: CurrentUser, input: IncomeEntryInput): Promise<{ transactionIds: number[] }> {
  assertAmount(input.amountMinor);
  const currency = assertCurrency(input.currency);
  const date = assertDate(input.date);
  const note = input.note?.trim() ?? "";
  return await db.transaction(async (q) => {
    const cat = (await q
      .select({ name: categories.name, kind: categories.kind, archivedAt: categories.archivedAt })
      .from(categories)
      .where(and(eq(categories.userId, user.id), eq(categories.id, input.categoryId)))
      .limit(1))[0];
    if (!cat || cat.archivedAt) throw new LedgerError("invalid", "category_not_found", `Category #${input.categoryId} does not exist`, { id: input.categoryId });
    if (cat.kind !== "income") throw new LedgerError("invalid", "category_not_for_income", `Category "${cat.name}" is not an income category`, { name: cat.name });
    let accountId: number;
    if (input.accountId === null) {
      accountId = await manualAccountId(q, user, currency);
    } else {
      const account = await accountOf(q, user, input.accountId);
      if (account.currency !== currency) {
        throw new LedgerError("invalid", "quick_currency_mismatch", `${account.name} holds ${account.currency}, not ${currency}`, { currency: account.currency });
      }
      accountId = account.id;
    }
    const row = (await q
      .insert(transactions)
      .values({
        userId: user.id,
        accountId,
        occurredAt: toOccurredAt(date),
        occurredOn: date,
        amountMinor: input.amountMinor,
        currency,
        kind: "income",
        descriptionRaw: note,
        merchant: note,
        categoryId: input.categoryId,
        source: "manual",
        dedupKey: manualDedupKey(),
      })
      .returning({ id: transactions.id }))[0]!;
    return { transactionIds: [row.id] };
  });
}

/**
 * Money moved between two of my accounts, typed by hand: two manual transfer rows (out of one, into the other) in the
 * accounts' shared currency, each pointing at the other through transfer_peer_id. Neither counts as spending or income.
 */
export async function createTransferEntry(db: Db, user: CurrentUser, input: TransferEntryInput): Promise<{ transactionIds: number[] }> {
  assertAmount(input.amountMinor);
  const date = assertDate(input.date);
  if (input.fromAccountId === input.toAccountId) throw new LedgerError("invalid", "quick_transfer_same_account", "Pick two different accounts");
  return await db.transaction(async (q) => {
    const from = await accountOf(q, user, input.fromAccountId);
    const to = await accountOf(q, user, input.toAccountId);
    if (from.currency !== to.currency) {
      throw new LedgerError("invalid", "quick_transfer_currency_mismatch", `${from.name} holds ${from.currency} and ${to.name} holds ${to.currency}`, {
        from: from.currency,
        to: to.currency,
      });
    }
    const leg = (accountId: number, amountMinor: number) => ({
      userId: user.id,
      accountId,
      occurredAt: toOccurredAt(date),
      occurredOn: date,
      amountMinor,
      currency: from.currency,
      kind: "transfer" as const,
      descriptionRaw: TRANSFER_TERM,
      merchant: "",
      source: "manual" as const,
      dedupKey: manualDedupKey(),
    });
    const out = (await q.insert(transactions).values(leg(from.id, -input.amountMinor)).returning({ id: transactions.id }))[0]!;
    const into = (await q.insert(transactions).values({ ...leg(to.id, input.amountMinor), transferPeerId: out.id }).returning({ id: transactions.id }))[0]!;
    await q.update(transactions).set({ transferPeerId: into.id }).where(eq(transactions.id, out.id));
    return { transactionIds: [out.id, into.id] };
  });
}
