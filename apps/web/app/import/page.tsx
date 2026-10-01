import { getCurrentUser, listBatches } from "@yomi/core";
import Link from "next/link";
import { connection } from "next/server";
import { BatchHistory } from "@/components/import/batch-history";
import { ImportFlow } from "@/components/import/import-flow";
import { SourceGuides } from "@/components/import/source-guides";
import { AnchorFlash } from "@/components/ui-kit/anchor-flash";
import { PageHeader } from "@/components/ui-kit/page-header";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t.import.title} · yomi` };
}

export default async function ImportPage() {
  await connection();
  const { t } = await getI18n();
  const batches = await listBatches(await getDb(), getCurrentUser());

  return (
    <div className="flex max-w-narrow flex-col gap-10">
      <div>
        <PageHeader title={t.import.title} />
        <ImportFlow />
      </div>

      <SourceGuides />

      <AnchorFlash />

      <div className="flex flex-col gap-3">
        <BatchHistory batches={batches} />
        <p className="text-meta text-2">
          {t.import.settingsHint}{" "}
          <Link href="/settings?tab=data" className="text-primary underline-offset-2 hover:underline">
            {t.tools.rulesPage.recategorizeLink}
          </Link>
        </p>
        <p id="bank" data-anchor className="scroll-mt-16 text-meta text-2">
          {t.import.banksHint}{" "}
          <Link href="/settings?tab=connections" className="text-primary underline-offset-2 hover:underline">
            {t.import.banksLink}
          </Link>
        </p>
      </div>
    </div>
  );
}
