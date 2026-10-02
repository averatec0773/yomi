import { periodOf } from "@yomi/core";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { fmt } from "@/i18n";
import { dayLabel } from "@/lib/month";
import { rangeLabel } from "@/lib/period";
import type { InsightContext } from "./insights";

const link = "text-primary underline-offset-4 hover:underline";

/**
 * A period with nothing counted: it stays selected, says where the newest counted row is and links to that row's period
 * (same kind; a month for a custom range). When the data is partial, one line says how far the sources reach instead
 * of a partial line per currency.
 */
export function EmptyPeriod({ ctx, icon, period }: { ctx: InsightContext; icon: LucideIcon; period: string }) {
  const { report, t, locale } = ctx;
  const e = t.analysis.empty;
  const day = (d: string) => dayLabel(d, locale, { year: d.slice(0, 4) !== report.today.slice(0, 4) });
  const latest = report.latestOn;
  const target = latest ? periodOf(report.kind === "range" ? "month" : report.kind, latest, report.weekStart) : null;
  const reach =
    Object.keys(report.partial).length > 0
      ? report.freshness.filter((f) => (f.kind === "stream" || f.kind === "export") && f.through).map((f) => f.through!).sort()
      : [];
  return (
    <EmptyState
      icon={icon}
      action={
        target ? (
          <Link href={`/analysis?${new URLSearchParams({ from: target.from, to: target.to }).toString()}`} className={link} data-testid="empty-latest-link">
            {fmt(e.view, { period: rangeLabel(target.from, target.to, locale) })}
          </Link>
        ) : (
          <Link href="/import" className={link}>
            {t.transactions.goImport}
          </Link>
        )
      }
    >
      {report.future ? e.future : fmt(report.inProgress ? e.noneYet : e.none, { period })}
      {latest && fmt(e.latest, { date: day(latest) })}
      {reach.length > 0 && (
        <span className="mt-1 block text-meta" data-testid="empty-reach">
          {reach[0] === reach.at(-1) ? fmt(e.reachOne, { date: day(reach[0]!) }) : fmt(e.reach, { from: day(reach[0]!), to: day(reach.at(-1)!) })}
        </span>
      )}
    </EmptyState>
  );
}
