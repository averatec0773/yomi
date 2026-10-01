import { CardSkeleton, HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { getI18n } from "@/i18n/server";

/** Shown while /split loads: person cards and the side sections as placeholders. */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-label={t.common.loading}>
      <HeaderSkeleton title={t.split.title} actions={2} />
      <div className="grid gap-4 xl:grid-cols-3 xl:gap-5">
        <div className="flex flex-col gap-4 xl:col-span-2">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-[10px]" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-10 w-48" />
            </div>
          ))}
          <CardSkeleton rows={4} />
        </div>
        <CardSkeleton rows={4} />
      </div>
    </div>
  );
}
