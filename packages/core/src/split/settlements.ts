import { participants, settlementItems, settlements, transactions, transactionSplits, type Db } from "@yomi/db";
import { and, desc, eq } from "@yomi/db/orm";
import { convertByRate, normalizeRate, rateFromAmounts } from "../money";
import { addDays } from "../time/day";
import type { CurrentUser } from "../user";
import { aaEvents, balanceOf } from "./balances";
import { allocateItems, coverageFor } from "./items";
import {
  assertCurrency,
  assertDate,
  getParticipant,
  getTransaction,
  nowIso,
  SplitError,
  type TransactionRow,
} from "./internal";

export type SettlementKind = "payment" | "opening";

export interface RecordSettlementInput {
  participantId: number;
  /** Signed: + they paid me, - I paid them. */
  amountMinor: number;
  currency: string;
  /** What actually changed hands when it differs (e.g. received ¥360 against a $50 balance). */
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  /**
   * Units of originalCurrency per 1 unit of currency, as a decimal string. With a rate and no original amount the
   * amount is derived (amount × rate, rounded once); with an amount and no rate the rate is derived.
   */
  fxRate?: string | null;
  settledOn: string;
  note?: string | null;
  transactionId?: number | null;
  /**
   * Pay these open split items (same person and currency). amountMinor may be less than what is open on them
   * (same sign), never more; see allocateItems.
   */
  itemTransactionIds?: number[] | null;
}

export interface Settlement {
  id: number;
  participantId: number;
  participantName: string;
  amountMinor: number;
  currency: string;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  fxRate: string | null;
  settledOn: string;
  note: string | null;
  transactionId: number | null;
  createdAt: string;
  kind: SettlementKind;
  /** kind === "opening": an opening balance rather than a payment. */
  opening: boolean;
}

async function assertNotLinked(db: Db, user: CurrentUser, transactionId: number): Promise<void> {
  const used = (await db
    .select({ id: settlements.id })
    .from(settlements)
    .where(and(eq(settlements.userId, user.id), eq(settlements.transactionId, transactionId)))
    .limit(1))[0];
  if (used) throw new SplitError("conflict", "settlement_already_linked", `Transaction ${transactionId} is already settlement #${used.id}`, {
      transactionId,
      settlementId: used.id,
    });
}

/**
 * A transaction can back a settlement when it is an open, non-duplicate income/expense/transfer row
 * that is not already split or linked. Split rows would count twice (once in the split, once here).
 */
async function assertLinkable(db: Db, user: CurrentUser, t: TransactionRow): Promise<void> {
  if (t.status !== "ok" || t.duplicateOfId !== null) throw new SplitError("invalid", "settlement_closed_or_duplicate", "A closed or duplicate transaction cannot be a settlement");
  if (t.kind !== "income" && t.kind !== "expense" && t.kind !== "transfer") {
    throw new SplitError("invalid", "settlement_kind_invalid", "Only income, expense or transfer rows can be a settlement");
  }
  await assertNotLinked(db, user, t.id);
  const hasSplits = (await db
    .select({ id: transactionSplits.id })
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, t.id))
    .limit(1))[0];
  if (hasSplits) throw new SplitError("invalid", "settlement_on_split_row", "This transaction is already split and cannot also be a settlement");
}

/** Fills in the original amount or the rate from the other one; null rate when the currencies are the same. */
function resolveFx(
  amountMinor: number,
  currency: string,
  input: Pick<RecordSettlementInput, "originalAmountMinor" | "originalCurrency" | "fxRate">,
): { originalAmountMinor: number | null; originalCurrency: string | null; fxRate: string | null } {
  let origAmount = input.originalAmountMinor ?? null;
  const origCurrency = input.originalCurrency != null && input.originalCurrency !== "" ? assertCurrency(input.originalCurrency) : null;
  let rate: string | null = null;
  if (input.fxRate != null && input.fxRate !== "") {
    rate = normalizeRate(input.fxRate);
    if (rate === null) throw new SplitError("invalid", "settlement_fx_rate_invalid", "The rate must be a positive decimal number", { value: input.fxRate });
    if (origCurrency === null) throw new SplitError("invalid", "settlement_original_incomplete", "The actual amount and its currency go together");
  }
  if (origAmount !== null && !Number.isSafeInteger(origAmount)) {
    throw new SplitError("invalid", "settlement_original_invalid", "The actual amount must be an integer (minor units)");
  }
  if (origCurrency !== null && origCurrency !== currency) {
    if (origAmount === null && rate !== null) {
      origAmount = Math.sign(amountMinor) * convertByRate(Math.abs(amountMinor), currency, rate, origCurrency);
      if (origAmount === 0) throw new SplitError("invalid", "settlement_original_invalid", "The actual amount rounds to zero");
    } else if (origAmount !== null && rate === null) {
      rate = rateFromAmounts(amountMinor, currency, origAmount, origCurrency);
    }
  } else {
    rate = null;
  }
  if ((origAmount !== null) !== (origCurrency !== null)) {
    throw new SplitError("invalid", "settlement_original_incomplete", "The actual amount and its currency go together");
  }
  return { originalAmountMinor: origAmount, originalCurrency: origCurrency, fxRate: rate };
}

async function insertSettlement(
  q: Db,
  user: CurrentUser,
  input: RecordSettlementInput,
  kind: SettlementKind,
  items: { transactionId: number; amountMinor: number }[] = [],
): Promise<Settlement> {
  const p = await getParticipant(q, user, input.participantId);
  if (p.isSelf) throw new SplitError("invalid", "settlement_with_self", "Cannot settle with \"me\"");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor === 0) {
    throw new SplitError("invalid", "settlement_amount_invalid", "The settlement amount must be a non-zero integer (minor units)");
  }
  const currency = assertCurrency(input.currency);
  const fx = resolveFx(input.amountMinor, currency, input);
  let linked: TransactionRow | null = null;
  if (input.transactionId != null) {
    linked = await getTransaction(q, user, input.transactionId);
    await assertLinkable(q, user, linked);
  }
  // A linked income/expense row becomes a transfer (the money was a repayment, not income or
  // spending); its old kind is kept so deleting the settlement can put it back.
  const flips = linked !== null && (linked.kind === "income" || linked.kind === "expense");
  const row = (await q
    .insert(settlements)
    .values({
      userId: user.id,
      participantId: p.id,
      amountMinor: input.amountMinor,
      currency,
      ...fx,
      settledOn: assertDate(input.settledOn),
      note: input.note?.trim() || null,
      transactionId: linked?.id ?? null,
      kind,
      priorKind: flips ? linked!.kind : null,
    })
    .returning()
    )[0]!;
  for (const it of items) {
    await q.insert(settlementItems)
      .values({ userId: user.id, settlementId: row.id, transactionId: it.transactionId, participantId: p.id, amountMinor: it.amountMinor, currency });
  }
  if (linked) {
    // user_edited_at also makes import revert keep the row (and so this settlement).
    await q.update(transactions)
      .set(flips ? { kind: "transfer", userEditedAt: nowIso() } : { userEditedAt: nowIso() })
      .where(eq(transactions.id, linked.id));
  }
  const { priorKind: _prior, userId: _user, ...out } = row;
  return { ...out, participantName: p.name, opening: row.kind === "opening" };
}

/** Allocates a settlement over the chosen open items (see allocateItems); throws when one is not open. */
async function itemsFor(q: Db, user: CurrentUser, input: RecordSettlementInput): Promise<{ transactionId: number; amountMinor: number }[]> {
  const ids = input.itemTransactionIds ?? [];
  if (ids.length === 0) return [];
  const currency = assertCurrency(input.currency);
  const open = (await coverageFor(q, user, input.participantId, currency)).entries.filter(
    (e) => e.kind === "split" && e.remainingMinor !== 0,
  );
  const wanted = new Set(ids);
  const chosen = open.filter((e) => wanted.has(e.transactionId!));
  if (chosen.length !== wanted.size) {
    const missing = [...wanted].filter((id) => !chosen.some((e) => e.transactionId === id));
    throw new SplitError("invalid", "settlement_item_not_open", `Not an open item with this person in ${currency}: ${missing.join(", ")}`, {
      ids: missing.join(", "),
    });
  }
  const out = allocateItems(
    chosen.map((e) => ({ transactionId: e.transactionId!, remainingMinor: e.remainingMinor })),
    input.amountMinor,
  );
  if (!out) {
    throw new SplitError("invalid", "settlement_items_amount_invalid", "The amount must be in the items' direction and at most their sum");
  }
  return out;
}

/** Records a payment. With transactionId, links that row (see insertSettlement). */
export async function recordSettlement(db: Db, user: CurrentUser, input: RecordSettlementInput): Promise<Settlement> {
  return await db.transaction(async (q) => await insertSettlement(q, user, input, "payment", await itemsFor(q, user, input)));
}

/**
 * Deletes a settlement. A linked transaction whose kind the settlement changed goes back to that
 * kind (prior_kind); otherwise the transaction's kind is left alone.
 */
export async function deleteSettlement(db: Db, user: CurrentUser, id: number): Promise<{ deleted: true; restoredTransactionId: number | null }> {
  return await db.transaction(async (q) => {
    const s = (await q
      .select()
      .from(settlements)
      .where(and(eq(settlements.userId, user.id), eq(settlements.id, id)))
      .limit(1))[0];
    if (!s) throw new SplitError("not_found", "settlement_not_found", `Settlement ${id} does not exist`, { id });
    await q.delete(settlementItems).where(eq(settlementItems.settlementId, id));
    await q.delete(settlements).where(eq(settlements.id, id));
    let restored: number | null = null;
    if (s.transactionId !== null && s.priorKind !== null) {
      const t = await getTransaction(q, user, s.transactionId);
      if (t.kind !== s.priorKind) {
        await q.update(transactions).set({ kind: s.priorKind, userEditedAt: nowIso() }).where(eq(transactions.id, t.id));
        restored = t.id;
      }
    }
    return { deleted: true as const, restoredTransactionId: restored };
  });
}

export async function listSettlements(db: Db, user: CurrentUser, participantId?: number): Promise<Settlement[]> {
  const rows = await db
    .select({
      id: settlements.id,
      participantId: settlements.participantId,
      participantName: participants.name,
      amountMinor: settlements.amountMinor,
      currency: settlements.currency,
      originalAmountMinor: settlements.originalAmountMinor,
      originalCurrency: settlements.originalCurrency,
      fxRate: settlements.fxRate,
      settledOn: settlements.settledOn,
      note: settlements.note,
      transactionId: settlements.transactionId,
      createdAt: settlements.createdAt,
      kind: settlements.kind,
    })
    .from(settlements)
    .innerJoin(participants, eq(participants.id, settlements.participantId))
    .where(
      and(
        eq(settlements.userId, user.id),
        ...(participantId === undefined ? [] : [eq(settlements.participantId, participantId)]),
      ),
    )
    .orderBy(desc(settlements.settledOn), desc(settlements.id));
  return rows.map((r) => ({ ...r, opening: r.kind === "opening" }));
}

export interface SettleAllInput {
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  fxRate?: string | null;
  settledOn: string;
  note?: string | null;
  transactionId?: number | null;
}

/**
 * Records exactly the current balance, so the participant's balance in that currency becomes zero. Every open
 * split item is recorded as paid by it; any difference (opening balances, money paid ahead) stays in the FIFO pool.
 */
export async function settleAll(
  db: Db,
  user: CurrentUser,
  participantId: number,
  currency: string,
  input: SettleAllInput,
): Promise<Settlement> {
  return await db.transaction(async (q) => {
    const c = assertCurrency(currency);
    const balance = await balanceOf(q, user, participantId, c);
    if (balance === 0) throw new SplitError("invalid", "settlement_already_even", `Already even in ${c}`, { currency: c });
    const items = (await coverageFor(q, user, participantId, c))
      .entries.filter((e) => e.kind === "split" && e.remainingMinor !== 0)
      .map((e) => ({ transactionId: e.transactionId!, amountMinor: e.remainingMinor }));
    return await insertSettlement(q, user, { ...input, participantId, amountMinor: balance, currency: c }, "payment", items);
  });
}

export interface OpeningBalanceInput {
  participantId: number;
  direction: "they_owe_me" | "i_owe_them";
  /** Magnitude in minor units, > 0. */
  amountMinor: number;
  currency: string;
  date: string;
  /** Free text stored as the settlement note; the row is marked by kind 'opening', not by the note. */
  note?: string | null;
}

/**
 * A starting point for history that was never recorded: stored as a settlement of kind 'opening'
 * with the sign that produces the balance (they owe me X → -X, since + settlements reduce what they
 * owe). Balances, history and statements recognize it by the kind column; the note is just a label.
 */
export async function recordOpeningBalance(db: Db, user: CurrentUser, input: OpeningBalanceInput): Promise<Settlement> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new SplitError("invalid", "opening_amount_invalid", "An opening balance must be a positive integer (minor units)");
  }
  const note = input.note?.trim() || null;
  return await db.transaction(async (q) =>
    await insertSettlement(
      q,
      user,
      {
        participantId: input.participantId,
        amountMinor: input.direction === "they_owe_me" ? -input.amountMinor : input.amountMinor,
        currency: input.currency,
        settledOn: input.date,
        note,
      },
      "opening",
    ),
  );
}

/**
 * "Start from a date, square before it": settles everything dated before `fromDate` with a settlement on the day
 * before, so later items stay open and the statement window starts at `fromDate`.
 */
export async function clearBefore(
  db: Db,
  user: CurrentUser,
  participantId: number,
  currency: string,
  fromDate: string,
  note?: string | null,
): Promise<Settlement> {
  return await db.transaction(async (q) => {
    const c = assertCurrency(currency);
    const from = assertDate(fromDate);
    const before = (await aaEvents(q, user, participantId))
      .filter((e) => e.currency === c && e.date < from)
      .reduce((s, e) => s + e.deltaMinor, 0);
    if (before === 0) throw new SplitError("invalid", "clear_before_already_even", `Already even before ${from}`, { date: from });
    return await recordSettlement(q, user, {
      participantId,
      amountMinor: before,
      currency: c,
      settledOn: addDays(from, -1),
      note: note?.trim() || null,
    });
  });
}

export { assertNotLinked };

/** Currencies that appear in the ledger (transactions and settlements), sorted; for FX pickers. */
export async function ledgerCurrencies(db: Db, user: CurrentUser): Promise<string[]> {
  const tx = await db.selectDistinct({ c: transactions.currency }).from(transactions).where(eq(transactions.userId, user.id));
  const st = await db.selectDistinct({ c: settlements.currency }).from(settlements).where(eq(settlements.userId, user.id));
  return [...new Set([...tx, ...st].map((r) => r.c))].sort();
}
