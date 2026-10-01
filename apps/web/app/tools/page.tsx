import { balances, getCurrentUser, listParticipants } from "@yomi/core";
import { connection } from "next/server";
import { ToolsHub } from "@/components/tools/tools-hub";
import { PageHeader } from "@/components/ui-kit/page-header";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { todayLocal } from "@/lib/month";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t.tools.metaTitle };
}

export default async function ToolsPage() {
  await connection();
  const { t } = await getI18n();
  const db = await getDb();
  const user = getCurrentUser();
  const people = (await listParticipants(db, user))
    .filter((p) => !p.isSelf)
    .map((p) => ({ id: p.id, name: p.name }));
  const currencies = [...new Set((await balances(db, user)).map((b) => b.currency))];

  return (
    // Narrow like the other Tools pages; wide enough for two columns of sections from 1200px. Sections live in ToolsHub.
    <div className="max-w-narrow min-[1200px]:max-w-list">
      <PageHeader title={t.tools.title} />
      <ToolsHub people={people} currencies={currencies} today={todayLocal()} />
    </div>
  );
}
