// Spending rule (plan §3): my share counts only for kind expense/refund, status ok, not linked, not a card hold.
// With splits it is my owed (sign follows the row: purchases positive, refunds negative);
// without splits it is −amount. Positive = money I spent.

export interface ShareRow {
  kind: "expense" | "income" | "transfer" | "refund";
  status: "ok" | "closed";
  duplicateOfId: number | null;
  amountMinor: number;
  /** A provisional capture counts (labelled); a card hold (pre-authorisation) does not until a statement row replaces it. */
  provisional: "capture" | "hold" | null;
}

export interface ShareSplit {
  isSelf: boolean;
  owedMinor: number;
}

export function countsAsSpending(row: ShareRow): boolean {
  return (row.kind === "expense" || row.kind === "refund") && row.status === "ok" && row.duplicateOfId == null && row.provisional !== "hold";
}

/** Income on the summary card: the whole amount of ok income rows that are not linked duplicates. */
export function countsAsIncome(row: ShareRow): boolean {
  return row.kind === "income" && row.status === "ok" && row.duplicateOfId == null;
}

export function myShareMinor(row: ShareRow, splits: readonly ShareSplit[]): number {
  if (!countsAsSpending(row)) return 0;
  if (splits.length === 0) return -row.amountMinor;
  const mine = splits.find((s) => s.isSelf)?.owedMinor ?? 0;
  return row.amountMinor > 0 ? -mine : mine;
}
