import { readAccessToken, safeNextPath } from "@yomi/core";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AccessForm } from "@/components/access/access-form";
import { PageHeader } from "@/components/ui-kit/page-header";
import { getI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t.access.metaTitle };
}

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  await connection();
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  if (readAccessToken() === null) redirect(next);
  const { t } = await getI18n();

  return (
    <div className="flex max-w-narrow flex-col">
      <PageHeader title={t.access.title} />
      <AccessForm next={next} />
    </div>
  );
}
