// Spending rule (plan §3): my share counts only for kind expense/refund, status ok, not linked, not a card hold.
// With splits it is my owed (sign follows the row: purchases positive, refunds negative);
// without splits it is −amount. Positive = money I spent.
// No imports: the web client paints optimistic totals with this same rule (@yomi/core/share).

export interface ShareRow {
  kind: "expense" | "income" | "transfer" | "refund";
  status: "ok" | "closed";
  duplicateOfId: number | null;
  amountMinor: number;
  /** A provisional capture counts (labelled); a card hold (pre-authorisation) does not until a statement row replaces it. */
  provisional: "capture" | "hold" | null;
  /** False when the row's category does not count as income (its counts_as_income flag is off); missing = counted. */
  incomeCounted?: boolean;
}

export interface ShareSplit {
  isSelf: boolean;
  owedMinor: number;
}

export function countsAsSpending(row: ShareRow): boolean {
  return (row.kind === "expense" || row.kind === "refund") && row.status === "ok" && row.duplicateOfId == null && row.provisional !== "hold";
}

/** Income on the summary card: the whole amount of ok income rows that are not linked duplicates, on a counted category. */
export function countsAsIncome(row: ShareRow): boolean {
  return row.kind === "income" && row.status === "ok" && row.duplicateOfId == null && row.incomeCounted !== false;
}

export function myShareMinor(row: ShareRow, splits: readonly ShareSplit[]): number {
  if (!countsAsSpending(row)) return 0;
  if (splits.length === 0) return -row.amountMinor;
  const mine = splits.find((s) => s.isSelf)?.owedMinor ?? 0;
  return row.amountMinor > 0 ? -mine : mine;
}
