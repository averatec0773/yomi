import { settlementItems } from "@yomi/db";
import { and, eq } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { type AaEvent, aaEvents } from "./balances";
import { assertCurrency, getParticipant, type Q } from "./internal";

/**
 * Which split items are still open with one person in one currency.
 *
 * A settlement can name the items it pays (settlement_items); those items are covered by exactly the recorded
 * amounts. The rest of every settlement (all of it for a legacy amount-only settlement, the part over its items
 * otherwise, and item rows whose split no longer exists) goes into one pool that covers the remaining entries
 * first in, first out:
 *
 * 1. Entries are the split items and opening balances, oldest first, each with what is left after explicit
 *    coverage (an item covered past its share gives the excess back to the pool).
 * 2. With pool L (signed like a payment: + they paid me) and prefix sums C_k of what is left, the entries up to
 *    the largest k with C_k between 0 and L (inclusive) are covered in full. This nets items against each other
 *    the way the running balance does: a dinner they paid for is used up by the groceries I paid for.
 * 3. The rest of the pool (L − C_k) then covers later entries of the same direction, oldest first, the last one
 *    partly. Whatever is still left is `unmatchedMinor` (money paid ahead of any item).
 *
 * The balance formula does not change: balance = Σ remaining − pool left = Σowed − Σpaid − Σsettlements.
 */

export type ItemStatus = "open" | "partial" | "covered";

export interface CoverageEntry {
  kind: "split" | "opening";
  event: AaEvent;
  /** Split items only. */
  transactionId: number | null;
  date: string;
  /** Signed like the balance: + they owe me. */
  deltaMinor: number;
  /** Part of delta still open, same sign as delta (0 when covered). */
  remainingMinor: number;
  status: ItemStatus;
  /** Settlements that named this item. */
  settledBy: number[];
}

export interface ItemRow {
  settlementId: number;
  transactionId: number;
  amountMinor: number;
}

export interface Coverage {
  entries: CoverageEntry[];
  /** Paid but matched to no item, signed like the balance (negative: they paid ahead). */
  unmatchedMinor: number;
  /** Items each settlement named, for the ones whose split still exists. */
  itemsBySettlement: Map<number, ItemRow[]>;
  balanceMinor: number;
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** `events`: one participant, one currency, time order (aaEvents). `rows`: that participant's settlement_items. */
export function coverageOf(events: readonly AaEvent[], rows: readonly ItemRow[]): Coverage {
  const entries: CoverageEntry[] = [];
  const byTx = new Map<number, CoverageEntry>();
  const payments: Extract<AaEvent, { type: "settlement" }>[] = [];
  for (const e of events) {
    if (e.type === "split") {
      if (e.deltaMinor === 0) continue;
      const entry: CoverageEntry = {
        kind: "split",
        event: e,
        transactionId: e.transactionId,
        date: e.date,
        deltaMinor: e.deltaMinor,
        remainingMinor: e.deltaMinor,
        status: "open",
        settledBy: [],
      };
      entries.push(entry);
      byTx.set(e.transactionId, entry);
    } else if (e.opening) {
      entries.push({
        kind: "opening",
        event: e,
        transactionId: null,
        date: e.date,
        deltaMinor: e.deltaMinor,
        remainingMinor: e.deltaMinor,
        status: "open",
        settledBy: [],
      });
    } else {
      payments.push(e);
    }
  }

  const bySettlement = new Map<number, ItemRow[]>();
  for (const r of rows) {
    let list = bySettlement.get(r.settlementId);
    if (!list) bySettlement.set(r.settlementId, (list = []));
    list.push(r);
  }

  // Explicit coverage; the rest of each settlement joins the pool.
  let pool = 0;
  const itemsBySettlement = new Map<number, ItemRow[]>();
  for (const s of payments) {
    let explicit = 0;
    const live: ItemRow[] = [];
    for (const r of bySettlement.get(s.settlementId) ?? []) {
      const entry = byTx.get(r.transactionId);
      if (!entry) continue;
      entry.remainingMinor -= r.amountMinor;
      entry.settledBy.push(s.settlementId);
      explicit += r.amountMinor;
      live.push(r);
    }
    if (live.length > 0) itemsBySettlement.set(s.settlementId, live);
    pool += s.amountMinor - explicit;
  }
  for (const entry of entries) {
    if (entry.remainingMinor !== 0 && sign(entry.remainingMinor) !== sign(entry.deltaMinor)) {
      pool -= entry.remainingMinor;
      entry.remainingMinor = 0;
    }
  }

  // FIFO over what is left.
  const queue = entries.filter((e) => e.remainingMinor !== 0);
  const within = (c: number) => (pool >= 0 ? c >= 0 && c <= pool : c <= 0 && c >= pool);
  let frontier = 0;
  let sum = 0;
  let covered = 0;
  queue.forEach((e, i) => {
    sum += e.remainingMinor;
    if (within(sum)) {
      frontier = i + 1;
      covered = sum;
    }
  });
  for (const e of queue.slice(0, frontier)) e.remainingMinor = 0;
  let rest = pool - covered;
  for (const e of queue.slice(frontier)) {
    if (rest === 0) break;
    if (sign(e.remainingMinor) !== sign(rest)) continue;
    const take = sign(rest) * Math.min(Math.abs(rest), Math.abs(e.remainingMinor));
    e.remainingMinor -= take;
    rest -= take;
  }

  for (const e of entries) {
    e.status = e.remainingMinor === 0 ? "covered" : e.remainingMinor === e.deltaMinor ? "open" : "partial";
  }
  const balanceMinor = entries.reduce((s, e) => s + e.remainingMinor, 0) - rest;
  return { entries, unmatchedMinor: rest === 0 ? 0 : -rest, itemsBySettlement, balanceMinor };
}

/**
 * The day each split item that is covered now became covered for good: replaying the events day by day, the
 * first day after which coverageOf keeps it covered through today. This works the same for items a settlement
 * named (settlement_items) and for legacy amount-only settlements covered first in, first out.
 */
export function settledOnDates(events: readonly AaEvent[], rows: readonly ItemRow[]): Map<number, string> {
  const out = new Map<number, string>();
  const pending = new Set(
    coverageOf(events, rows)
      .entries.filter((e) => e.kind === "split" && e.status === "covered")
      .map((e) => e.transactionId!),
  );
  for (let i = events.length - 1; i >= 0 && pending.size > 0; i--) {
    const date = events[i]!.date;
    if (i + 1 < events.length && events[i + 1]!.date === date) continue;
    const covered = new Set(
      coverageOf(events.slice(0, i + 1), rows)
        .entries.filter((e) => e.kind === "split" && e.status === "covered")
        .map((e) => e.transactionId!),
    );
    for (const id of [...pending]) {
      if (covered.has(id)) out.set(id, date);
      else pending.delete(id);
    }
  }
  return out;
}

export async function itemRowsOf(db: Q, user: CurrentUser, participantId: number, currency: string): Promise<ItemRow[]> {
  return await db
    .select({
      settlementId: settlementItems.settlementId,
      transactionId: settlementItems.transactionId,
      amountMinor: settlementItems.amountMinor,
    })
    .from(settlementItems)
    .where(
      and(
        eq(settlementItems.userId, user.id),
        eq(settlementItems.participantId, participantId),
        eq(settlementItems.currency, currency),
      ),
    );
}

export async function coverageFor(db: Q, user: CurrentUser, participantId: number, currency: string): Promise<Coverage> {
  const c = assertCurrency(currency);
  const events = (await aaEvents(db, user, participantId)).filter((e) => e.currency === c);
  return coverageOf(events, await itemRowsOf(db, user, participantId, c));
}

export interface OpenItem {
  transactionId: number;
  date: string;
  merchant: string;
  totalMinor: number;
  /** The item's full effect on the balance (+ they owe me). */
  deltaMinor: number;
  /** What is still open of it. */
  remainingMinor: number;
  status: Exclude<ItemStatus, "covered">;
  paidByThem: boolean;
  sharedNote: string | null;
}

export function toOpenItem(e: CoverageEntry): OpenItem | null {
  if (e.event.type !== "split" || e.status === "covered") return null;
  return {
    transactionId: e.event.transactionId,
    date: e.date,
    merchant: e.event.merchant,
    totalMinor: e.event.totalMinor,
    deltaMinor: e.deltaMinor,
    remainingMinor: e.remainingMinor,
    status: e.status,
    paidByThem: e.event.paidMinor !== 0,
    sharedNote: e.event.sharedNote,
  };
}

/** Split items still open with this person in this currency, oldest first. */
export async function openItems(db: Q, user: CurrentUser, participantId: number, currency: string): Promise<OpenItem[]> {
  await getParticipant(db, user, participantId);
  return (await coverageFor(db, user, participantId, currency))
    .entries.map(toOpenItem)
    .filter((x): x is OpenItem => x !== null);
}

/**
 * Splits a settlement of `amountMinor` over the chosen open items. The amount may be smaller than the items' sum
 * (same sign), never larger: the shortfall comes off the newest items of the sum's direction first, so the oldest
 * are paid in full. Items that end up with nothing are dropped.
 */
export function allocateItems(
  items: readonly { transactionId: number; remainingMinor: number }[],
  amountMinor: number,
): { transactionId: number; amountMinor: number }[] | null {
  const total = items.reduce((s, i) => s + i.remainingMinor, 0);
  if (total === 0 || amountMinor === 0 || sign(amountMinor) !== sign(total) || Math.abs(amountMinor) > Math.abs(total)) return null;
  const out = items.map((i) => ({ transactionId: i.transactionId, amountMinor: i.remainingMinor }));
  let cut = total - amountMinor;
  for (let i = out.length - 1; i >= 0 && cut !== 0; i--) {
    const it = out[i]!;
    if (sign(it.amountMinor) !== sign(cut)) continue;
    const take = sign(cut) * Math.min(Math.abs(cut), Math.abs(it.amountMinor));
    it.amountMinor -= take;
    cut -= take;
  }
  return out.filter((i) => i.amountMinor !== 0);
}
