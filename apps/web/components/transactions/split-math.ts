import type { SplitItem, SplitView, TransactionItem } from "@yomi/contracts";
import { splitEqual } from "@yomi/core/money";

/**
 * Client mirror of the split rules in packages/core (split/splits.ts, ledger/share.ts), used only to
 * paint the optimistic state; the server response replaces it right after.
 */

export type SplitMode = "equal" | "full" | "exact";

export interface SplitState {
  mode: SplitMode;
  payerId: number;
  /** Non-self participants sharing the row (a friend payer with owed 0 is not listed). */
  participantIds: number[];
}

export function countsAsSpending(t: Pick<TransactionItem, "kind" | "status" | "duplicateOfId" | "provisional">): boolean {
  return (t.kind === "expense" || t.kind === "refund") && t.status === "ok" && t.duplicateOfId == null && t.provisional !== "hold";
}

export function myShareOf(t: TransactionItem, splits: readonly SplitItem[]): number {
  if (!countsAsSpending(t)) return 0;
  if (splits.length === 0) return -t.amountMinor;
  const mine = splits.find((s) => s.isSelf)?.owedMinor ?? 0;
  return t.amountMinor > 0 ? -mine : mine;
}

/** Rows that take participant chips: open, non-duplicate expenses. */
export function canSplit(t: Pick<TransactionItem, "kind" | "status" | "duplicateOfId">): boolean {
  return t.kind === "expense" && t.status === "ok" && t.duplicateOfId == null;
}

export function splitStateOf(t: TransactionItem, selfId: number): SplitState | null {
  const s = t.splits;
  if (s.length === 0) return null;
  const payer = s.find((r) => r.paidMinor !== 0) ?? s.find((r) => r.isSelf);
  const payerId = payer?.participantId ?? selfId;
  const participantIds = s
    .filter((r) => !r.isSelf && !(r.participantId === payerId && r.owedMinor === 0))
    .map((r) => r.participantId);
  const total = Math.abs(t.amountMinor);
  const myOwed = s.find((r) => r.isSelf)?.owedMinor ?? 0;
  let mode: SplitMode = "exact";
  const group = [selfId, ...participantIds];
  const equal = splitEqual(total, group.length);
  const owedOf = (id: number) => s.find((r) => r.participantId === id)?.owedMinor ?? 0;
  if (group.every((id, i) => owedOf(id) === equal[i])) mode = "equal";
  else if (payerId === selfId && myOwed === 0) mode = "full";
  return { mode, payerId, participantIds };
}

/** Builds split rows the way core setSplit does (self first, then by participant id). */
export function buildSplits(
  t: TransactionItem,
  input: { participantIds: number[]; mode: SplitMode; exact?: Map<number, number>; payerId: number },
  selfId: number,
  nameOf: (id: number) => string,
): SplitItem[] {
  const others = [...new Set(input.participantIds)].filter((id) => id !== selfId);
  if (others.length === 0 && input.payerId === selfId) return [];
  const total = Math.abs(t.amountMinor);
  const owed = new Map<number, number>();
  if (input.mode === "equal") {
    const group = [selfId, ...others];
    splitEqual(total, group.length).forEach((v, i) => owed.set(group[i]!, v));
  } else if (input.mode === "full") {
    owed.set(selfId, 0);
    if (others.length) splitEqual(total, others.length).forEach((v, i) => owed.set(others[i]!, v));
  } else {
    let sum = 0;
    for (const id of others) {
      const v = input.exact?.get(id) ?? 0;
      owed.set(id, v);
      sum += v;
    }
    owed.set(selfId, Math.max(total - sum, 0));
  }
  if (input.payerId !== selfId) {
    // Friend paid: core stores only me and the payer (star model).
    const mine = owed.get(selfId) ?? 0;
    owed.clear();
    owed.set(selfId, mine);
    owed.set(input.payerId, total - mine);
  }
  if (!owed.has(input.payerId)) owed.set(input.payerId, 0);
  return [...owed]
    .map(([participantId, owedMinor]) => ({
      participantId,
      name: nameOf(participantId),
      isSelf: participantId === selfId,
      owedMinor,
      paidMinor: participantId === input.payerId ? total : 0,
    }))
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.participantId - b.participantId);
}

/** The one-tap chip rule from core toggleParticipant. */
export function toggledSplits(t: TransactionItem, participantId: number, selfId: number, nameOf: (id: number) => string): SplitItem[] {
  const cur = splitStateOf(t, selfId);
  if (!cur) return buildSplits(t, { participantIds: [participantId], mode: "equal", payerId: selfId }, selfId, nameOf);
  const ids = cur.participantIds.includes(participantId)
    ? cur.participantIds.filter((id) => id !== participantId)
    : [...cur.participantIds, participantId];
  const mode: SplitMode = cur.mode === "full" ? "full" : "equal";
  return buildSplits(t, { participantIds: ids, mode, payerId: cur.payerId }, selfId, nameOf);
}

export function withSplits(t: TransactionItem, splits: SplitItem[]): TransactionItem {
  return { ...t, splits, myShareMinor: myShareOf(t, splits), suggestedParticipantIds: splits.length ? [] : t.suggestedParticipantIds };
}

export function withSplitView(t: TransactionItem, view: SplitView | null): TransactionItem {
  return withSplits(t, view ? view.rows.map((r) => ({ ...r })).sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.participantId - b.participantId) : []);
}

export function isOn(t: TransactionItem, participantId: number): boolean {
  return t.splits.some((s) => s.participantId === participantId && !s.isSelf && (s.owedMinor > 0 || s.paidMinor === 0));
}
