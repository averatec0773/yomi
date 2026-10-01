import type { BankSyncResult } from "@yomi/contracts";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/en";

/** "3 new, 1 updated, 2 linked": only the non-zero counts after "new". */
export function syncSummary(
  r: Pick<BankSyncResult, "inserted" | "skippedDup" | "linked" | "autoSplit" | "modified" | "removed">,
  t: Dictionary,
): string {
  const s = t.bank.summary;
  const parts = [fmt(s.inserted, { count: r.inserted })];
  if (r.modified) parts.push(fmt(s.modified, { count: r.modified }));
  if (r.removed) parts.push(fmt(s.removed, { count: r.removed }));
  if (r.skippedDup) parts.push(fmt(s.skippedDup, { count: r.skippedDup }));
  if (r.linked) parts.push(fmt(s.linked, { count: r.linked }));
  if (r.autoSplit) parts.push(fmt(s.autoSplit, { count: r.autoSplit }));
  return parts.join(s.sep);
}
