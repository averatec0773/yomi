import { HeaderSkeleton, ListSkeleton, Skeleton } from "@/components/skeleton";
import { getI18n } from "@/i18n/server";

/** Shown while /transactions loads or changes period: header, spend strip, chips and list as placeholders. */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-label={t.common.loading}>
      <HeaderSkeleton title={t.transactions.title} controls actions={1} />
      <div className="flex flex-col gap-5">
        <Skeleton className="h-10 w-72" />
        <div className="flex gap-2">
          {[120, 110, 96, 120].map((w, i) => (
            <Skeleton key={i} className="h-9 shrink-0 rounded-full" style={{ width: w }} />
          ))}
        </div>
        <ListSkeleton />
      </div>
    </div>
  );
}
