import type { SplitSuggestion } from "@yomi/contracts";
import { fmt, plural } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import type { Dictionary } from "@/i18n/en";

/** The suggestion's reason in the UI language ("Split with Alex the last 5 times"); null when it has none. */
export function suggestionReason(s: SplitSuggestion, t: Dictionary, nameOf: (id: number) => string): string | null {
  if (!s.reason) return null;
  const names = s.participantIds.map(nameOf).join(t.common.listSep);
  const p = s.reason.params;
  const r = t.aa.reasons;
  switch (s.reason.code) {
    case "suggest_merchant_recent":
      return plural(r.merchantRecent, Number(p.count ?? 1), { names });
    case "suggest_merchant_before":
      return fmt(r.merchantBefore, { names, merchant: String(p.merchant ?? "") });
    case "suggest_category_share":
      return fmt(r.categoryShare, { names, percent: Number(p.percent ?? 0), category: categoryLabel(String(p.category ?? ""), t) });
    default:
      return null;
  }
}
