import { participants, settlementItems, settlements, transactions, transactionSplits } from "@yomi/db";
import { and, eq, inArray, isNull } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import type { Q } from "./internal";
import { coverageOf, type ItemRow } from "./items";

/** One entry on a participant's running AA account in one currency. delta > 0 means they owe me more. */
export type AaEvent =
  | {
      type: "split";
      participantId: number;
      currency: string;
      date: string;
      sortKey: string;
      deltaMinor: number;
      transactionId: number;
      occurredAt: string;
      merchant: string;
      totalMinor: number;
      owedMinor: number;
      paidMinor: number;
      /** The transaction's note for the people it is shared with. */
      sharedNote: string | null;
    }
  | {
      type: "settlement";
      participantId: number;
      currency: string;
      date: string;
      sortKey: string;
      deltaMinor: number;
      settlementId: number;
      amountMinor: number;
      originalAmountMinor: number | null;
      originalCurrency: string | null;
      fxRate: string | null;
      note: string | null;
      /** An opening balance, not money that changed hands. */
      opening: boolean;
    };

/**
 * Owed/paid/total on split events are signed from my point of view (refund rows negative).
 * All split rows (on expense/refund transactions that are status ok and not duplicates, the same
 * rows spending counts) and settlements for non-self
 * participants, in time order. Same-day opening balances sort before that day's splits, settlements after.
 */
export async function aaEvents(db: Q, user: CurrentUser, participantId?: number): Promise<AaEvent[]> {
  const splitRows = await db
    .select({
      participantId: transactionSplits.participantId,
      currency: transactionSplits.currency,
      owedMinor: transactionSplits.owedMinor,
      paidMinor: transactionSplits.paidMinor,
      splitId: transactionSplits.id,
      transactionId: transactions.id,
      occurredAt: transactions.occurredAt,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
      counterpartyRaw: transactions.counterpartyRaw,
      amountMinor: transactions.amountMinor,
      sharedNote: transactions.sharedNote,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .innerJoin(participants, eq(participants.id, transactionSplits.participantId))
    .where(
      and(
        eq(transactionSplits.userId, user.id),
        eq(participants.isSelf, false),
        inArray(transactions.kind, ["expense", "refund"]),
        eq(transactions.status, "ok"),
        isNull(transactions.duplicateOfId),
        ...(participantId === undefined ? [] : [eq(transactionSplits.participantId, participantId)]),
      ),
    );
  const settlementRows = await db
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.userId, user.id),
        ...(participantId === undefined ? [] : [eq(settlements.participantId, participantId)]),
      ),
    );

  // Same day: opening balances first, then splits, then settlements.
  // Split rows store magnitudes; a refund (amount > 0) runs the other way.
  const dir = (amountMinor: number) => (amountMinor > 0 ? -1 : 1);
  const pad = (n: number) => String(n).padStart(12, "0");
  const events: AaEvent[] = [
    ...splitRows.filter((r) => r.owedMinor !== 0 || r.paidMinor !== 0).map((r): AaEvent => ({
      type: "split",
      participantId: r.participantId,
      currency: r.currency,
      date: r.occurredAt.slice(0, 10),
      sortKey: `${r.occurredAt.slice(0, 10)}|1|${r.occurredAt}|${pad(r.splitId)}`,
      deltaMinor: dir(r.amountMinor) * (r.owedMinor - r.paidMinor),
      transactionId: r.transactionId,
      occurredAt: r.occurredAt,
      merchant: r.merchant || r.descriptionRaw || r.counterpartyRaw,
      totalMinor: -r.amountMinor,
      owedMinor: dir(r.amountMinor) * r.owedMinor,
      paidMinor: dir(r.amountMinor) * r.paidMinor,
      sharedNote: r.sharedNote,
    })),
    ...settlementRows.map((s): AaEvent => ({
      type: "settlement",
      participantId: s.participantId,
      currency: s.currency,
      date: s.settledOn,
      sortKey: `${s.settledOn}|${s.kind === "opening" ? 0 : 2}|${s.createdAt}|${pad(s.id)}`,
      deltaMinor: -s.amountMinor,
      settlementId: s.id,
      amountMinor: s.amountMinor,
      originalAmountMinor: s.originalAmountMinor,
      originalCurrency: s.originalCurrency,
      fxRate: s.fxRate,
      note: s.note,
      opening: s.kind === "opening",
    })),
  ];
  return events.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

export interface AaAccount {
  participantId: number;
  currency: string;
  balanceMinor: number;
  /** Events after the last point where the running balance was zero (all events if it never was). */
  open: AaEvent[];
  /** Date of the last zero point, null if the balance was never zero after an event. */
  zeroSince: string | null;
  lastSettledOn: string | null;
}

/** Groups events by (participant, currency) and finds each account's last zero-balance point. */
export function aaAccounts(events: readonly AaEvent[]): AaAccount[] {
  const groups = new Map<string, AaEvent[]>();
  for (const e of events) {
    const k = `${e.participantId}|${e.currency}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(e);
  }
  const out: AaAccount[] = [];
  for (const g of groups.values()) {
    let running = 0;
    let zeroAt = -1;
    let lastSettledOn: string | null = null;
    g.forEach((e, i) => {
      running += e.deltaMinor;
      if (running === 0) zeroAt = i;
      if (e.type === "settlement" && !e.opening && (lastSettledOn === null || e.date > lastSettledOn)) lastSettledOn = e.date;
    });
    out.push({
      participantId: g[0]!.participantId,
      currency: g[0]!.currency,
      balanceMinor: running,
      open: g.slice(zeroAt + 1),
      zeroSince: zeroAt >= 0 ? g[zeroAt]!.date : null,
      lastSettledOn,
    });
  }
  return out;
}

export interface Balance {
  participantId: number;
  name: string;
  archived: boolean;
  currency: string;
  /** Σowed − Σpaid − Σsettlements. Positive: they owe me. Negative: I owe them. */
  owedToMeMinor: number;
  lastSettledOn: string | null;
  /** Split items not yet covered by a settlement (see items.ts). */
  openItemCount: number;
}

/** One line per participant per currency. Currencies are never summed. */
export async function balances(db: Q, user: CurrentUser): Promise<Balance[]> {
  const people = new Map(
    (await db
      .select()
      .from(participants)
      .where(and(eq(participants.userId, user.id), eq(participants.isSelf, false)))
      )
      .map((p) => [p.id, p]),
  );
  const events = await aaEvents(db, user);
  const rows = new Map<string, ItemRow[]>();
  for (const r of (await db.select().from(settlementItems).where(eq(settlementItems.userId, user.id)))) {
    const k = `${r.participantId}|${r.currency}`;
    rows.set(k, [...(rows.get(k) ?? []), { settlementId: r.settlementId, transactionId: r.transactionId, amountMinor: r.amountMinor }]);
  }
  const openCount = (participantId: number, currency: string) =>
    coverageOf(
      events.filter((e) => e.participantId === participantId && e.currency === currency),
      rows.get(`${participantId}|${currency}`) ?? [],
    ).entries.filter((e) => e.kind === "split" && e.status !== "covered").length;
  return aaAccounts(events)
    .flatMap((a): Balance[] => {
      const p = people.get(a.participantId);
      if (!p) return [];
      if (p.archivedAt && a.balanceMinor === 0) return [];
      return [
        {
          participantId: p.id,
          name: p.name,
          archived: p.archivedAt !== null,
          currency: a.currency,
          owedToMeMinor: a.balanceMinor,
          lastSettledOn: a.lastSettledOn,
          openItemCount: openCount(a.participantId, a.currency),
        },
      ];
    })
    .sort((a, b) => a.participantId - b.participantId || (a.currency < b.currency ? -1 : 1));
}

export async function balanceOf(db: Q, user: CurrentUser, participantId: number, currency: string): Promise<number> {
  return (await aaEvents(db, user, participantId))
    .filter((e) => e.currency === currency)
    .reduce((s, e) => s + e.deltaMinor, 0);
}
