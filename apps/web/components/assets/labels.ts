import type { InvestSyncResult } from "@yomi/contracts";
import { toast } from "sonner";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { errorText, noticeText } from "@/i18n/errors";
import { fmt, plural } from "@/i18n/format";
import { dayLabel } from "@/lib/month";

/** "Interactive Brokers, 5 positions, Plaid, 2 positions": one part per provider that returned holdings. */
export function investSyncSummary(r: InvestSyncResult, t: Dictionary): string {
  const counts = new Map<string, number>();
  for (const x of r.results) counts.set(x.provider, (counts.get(x.provider) ?? 0) + x.positions + x.cashBalances);
  return [...counts]
    .map(([p, n]) => plural(t.assets.syncItem, n, { name: t.assets.providers[p] ?? p }))
    .join(t.common.listSep);
}

/** Toasts the outcome of POST /api/invest/sync: summary, a calm note for a statement not published yet, each failed pull by its code, warnings. */
export function toastInvestSync(r: InvestSyncResult, t: Dictionary, locale: Locale): void {
  if (r.results.length) toast.success(fmt(t.assets.synced, { summary: investSyncSummary(r, t) }));
  for (const x of r.results) {
    if (x.stale && x.expectedAsOf) toast.info(fmt(t.assets.ibkrStale, { date: dayLabel(x.expectedAsOf, locale) }), { duration: 10_000 });
  }
  for (const e of r.errors) toast.error(errorText(e, t), { duration: 10_000 });
  const warnings = r.results.flatMap((x) => x.warnings);
  if (warnings.length) toast.warning(warnings.map((w) => noticeText(w, t)).join("\n"));
  if (!r.results.length && !r.errors.length) toast.info(t.assets.nothingToSync);
}
