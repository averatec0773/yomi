import { CardSkeleton, HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { getI18n } from "@/i18n/server";

/** Shown while /import loads: the drop zone and history as placeholders. */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-label={t.common.loading} className="max-w-narrow">
      <HeaderSkeleton title={t.import.title} />
      <div className="flex flex-col gap-10">
        <Skeleton className="h-40 w-full rounded-xl" />
        <CardSkeleton rows={3} />
      </div>
    </div>
  );
}
