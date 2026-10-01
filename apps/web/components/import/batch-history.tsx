import type { BatchSummary } from "@yomi/core";
import { HistoryIcon } from "lucide-react";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { ListCard } from "@/components/ui-kit/list-card";
import { getI18n } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { shortDateTime } from "./labels";
import { RevertBatch } from "./revert-batch";

function reconciled(b: BatchSummary): boolean {
  const d = b.declared;
  const p = b.parsed ?? {};
  if (!d) return true;
  if (d.count != null && d.count !== (p.count ?? 0)) return false;
  return (["expense", "income", "neutral"] as const).every((k) => {
    const x = d[k];
    const y = p[k] ?? { count: 0, minor: 0 };
    return !x || (x.count === y.count && x.minor === y.minor);
  });
}

/** "Import history": batches newest first in a ListCard, two lines per batch on narrow screens. */
export async function BatchHistory({ batches }: { batches: BatchSummary[] }) {
  const { locale, t } = await getI18n();
  const bt = t.import.batches;
  const sourceOf = (s: string) => t.import.sources[s as keyof typeof t.import.sources] ?? s;
  if (batches.length === 0) {
    return (
      <section aria-label={t.import.history} className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-title font-semibold">
          <HistoryIcon className="size-[18px] text-2" aria-hidden />
          {t.import.history}
        </h2>
        <EmptyState icon={HistoryIcon}>{bt.empty}</EmptyState>
      </section>
    );
  }

  return (
    <ListCard icon={HistoryIcon} title={t.import.history} count={batches.length}>
      <div className="hidden h-row-compact grid-cols-[8.5rem_9.5rem_minmax(0,1fr)_7.5rem_5.5rem] items-center gap-3 px-4 text-meta whitespace-nowrap text-2 sm:grid md:px-5">
        <span>{bt.time}</span>
        <span>{bt.source}</span>
        <span>{bt.file}</span>
        <span className="text-right">{bt.counts}</span>
        <span className="text-right">{bt.status}</span>
      </div>
      <ul className="divide-y divide-line-soft">
        {batches.map((b) => {
          const reverted = b.status === "reverted";
          return (
            <li
              key={b.id}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 sm:min-h-12 sm:grid-cols-[8.5rem_9.5rem_minmax(0,1fr)_7.5rem_5.5rem] sm:py-1 md:px-5",
                reverted && "text-2",
              )}
            >
              <span className="num order-3 text-left text-meta text-2 sm:order-none sm:text-body">{shortDateTime(b.createdAt, locale)}</span>
              <span className="order-4 hidden sm:order-none sm:block">{sourceOf(b.source)}</span>
              <span className="order-1 min-w-0 truncate sm:order-none" title={b.fileName}>
                <span className="text-2 sm:hidden">{sourceOf(b.source)} · </span>
                <span className="mr-1.5 text-meta text-2">#{b.id}</span>
                {b.fileName}
                {!reconciled(b) && <span className="ml-2 text-meta text-neg">{bt.mismatch}</span>}
              </span>
              <span className="num order-4 text-meta text-2 sm:order-none sm:text-body sm:text-foreground">
                {b.rowsTotal} / {b.rowsInserted} / {b.rowsSkippedDup}
              </span>
              <span className="order-2 flex justify-end sm:order-none">
                {reverted ? (
                  <span className="text-meta text-2" title={b.revertedAt ? shortDateTime(b.revertedAt, locale) : undefined}>
                    {bt.reverted}
                  </span>
                ) : (
                  <RevertBatch id={b.id} fileName={b.fileName} inserted={b.rowsInserted} />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </ListCard>
  );
}
