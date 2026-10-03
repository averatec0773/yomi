import { CompassIcon, ReceiptTextIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui-kit/button";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { PageHeader } from "@/components/ui-kit/page-header";
import { getI18n } from "@/i18n/server";

/** Any address with no page, inside the shell, with a way back to the list. */
export default async function NotFound() {
  const { t } = await getI18n();
  return (
    <div className="max-w-narrow">
      <PageHeader title={t.errorPage.notFoundTitle} />
      <EmptyState
        icon={CompassIcon}
        action={
          <Button asChild>
            <Link href="/transactions">
              <ReceiptTextIcon aria-hidden />
              {t.errorPage.toTransactions}
            </Link>
          </Button>
        }
      >
        {t.errorPage.notFoundBody}
      </EmptyState>
    </div>
  );
}
