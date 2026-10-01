import { CardSkeleton, HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { getI18n } from "@/i18n/server";

/** Shown while /assets loads: the net worth card with its curve, the by-currency card and two lists. */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-label={t.common.loading}>
      <HeaderSkeleton title={t.assets.title} controls actions={1} />
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 lg:col-span-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-[150px] w-full" />
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CardSkeleton rows={5} />
          <CardSkeleton rows={5} />
        </div>
      </div>
    </div>
  );
}
