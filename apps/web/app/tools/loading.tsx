import { CardSkeleton, HeaderSkeleton } from "@/components/skeleton";
import { getI18n } from "@/i18n/server";

/** Shown while /tools loads: the Split, Data and Maintenance cards as placeholders. */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-label={t.common.loading} className="flex max-w-narrow flex-col gap-6">
      <HeaderSkeleton title={t.tools.title} />
      <CardSkeleton rows={2} />
      <CardSkeleton rows={3} />
      <CardSkeleton rows={4} />
    </div>
  );
}
