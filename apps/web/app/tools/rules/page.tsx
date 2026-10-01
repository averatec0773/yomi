import { TagsIcon } from "lucide-react";
import { getCurrentUser, listMerchantRules } from "@yomi/core";
import Link from "next/link";
import { connection } from "next/server";
import { AutoSplitRules } from "@/components/split/auto-split-rules";
import { ListCard } from "@/components/ui-kit/list-card";
import { PageHeader } from "@/components/ui-kit/page-header";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t.tools.rulesPage.metaTitle };
}

export default async function RulesPage() {
  await connection();
  const { t } = await getI18n();
  const r = t.tools.rulesPage;
  const rules = await listMerchantRules(await getDb(), getCurrentUser(), { autoSplitOnly: true });

  return (
    <div className="flex max-w-narrow flex-col gap-6">
      <PageHeader title={r.title} className="mb-0" />
      <AutoSplitRules rules={rules} />
      <ListCard icon={TagsIcon} title={r.categoryRules}>
        <p className="px-4 py-3 text-meta text-2 md:px-5">
          {r.categoryRulesBody}{" "}
          <Link href="/settings?tab=data#recategorize" className="text-primary underline-offset-2 hover:underline">
            {r.recategorizeLink}
          </Link>
        </p>
      </ListCard>
    </div>
  );
}
