import { CardSkeleton, HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { getI18n } from "@/i18n/server";

const TAB_WIDTHS = ["w-24", "w-20", "w-28", "w-24", "w-28", "w-20", "w-16"];

/** Shown while /settings loads: the tab bar and one panel (title, hint, a card). */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-label={t.common.loading} className="flex flex-col gap-6">
      <HeaderSkeleton title={t.settings.title} />
      <div className="-mx-gutter -mt-6 overflow-hidden md:mx-0">
        <div className="flex gap-1 border-b border-border px-gutter py-1.5 md:px-0 md:py-2">
          {TAB_WIDTHS.map((w, i) => (
            <Skeleton key={i} className={`h-11 shrink-0 rounded-lg md:h-9 ${w}`} />
          ))}
        </div>
      </div>
      <div className="flex max-w-narrow flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <CardSkeleton rows={2} header={false} />
      </div>
    </div>
  );
}
