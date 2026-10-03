"use client";

import { CircleAlertIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui-kit/button";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { PageHeader } from "@/components/ui-kit/page-header";
import { useT } from "@/i18n/client";

/**
 * A page that threw (a locked PGlite directory, a failed migration, a core error on bad params) inside the shell. In
 * production the message of a server error is redacted, so the page says one calm sentence and offers Try again,
 * which fetches and renders the page again.
 */
export default function ErrorPage({ retry }: { retry: () => void }) {
  const t = useT();
  return (
    <div className="max-w-narrow">
      <PageHeader title={t.errorPage.title} />
      <EmptyState
        icon={CircleAlertIcon}
        action={
          <Button onClick={retry}>
            <RotateCwIcon aria-hidden />
            {t.common.retry}
          </Button>
        }
      >
        {t.errorPage.body}
      </EmptyState>
    </div>
  );
}
