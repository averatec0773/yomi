import { CardSkeleton, HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { getI18n } from "@/i18n/server";

/** Shown while /stats loads or changes period: summary card, trend and category rows as placeholders. */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-label={t.common.loading}>
      <HeaderSkeleton title={t.stats.title} controls actions={1} />
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <Skeleton className="h-3.5 w-36" />
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
        <div className="flex h-40 items-end gap-3">
          {[55, 80, 40, 95, 70, 60].map((h, i) => (
            <Skeleton key={i} className="flex-1 rounded-sm" style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <CardSkeleton rows={6} />
          <CardSkeleton rows={5} />
        </div>
      </div>
    </div>
  );
}
