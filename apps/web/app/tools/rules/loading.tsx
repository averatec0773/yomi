import { CardSkeleton, HeaderSkeleton } from "@/components/skeleton";
import { getI18n } from "@/i18n/server";

/** Shown while /tools/rules loads: the two rule cards as placeholders. */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-label={t.common.loading} className="flex max-w-narrow flex-col gap-6">
      <HeaderSkeleton title={t.tools.rulesPage.title} />
      <CardSkeleton rows={3} />
      <CardSkeleton rows={1} />
    </div>
  );
}
