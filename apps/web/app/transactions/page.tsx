import {
  balances,
  countReview,
  getCurrentUser,
  listCategories,
  listMerchantRules,
  listMonths,
  listParticipants,
  listTransactions,
  monthRangeOf,
  rangeTotalsForList,
  wholeMonths,
} from "@yomi/core";
import { AddButton, TxSearch } from "@/components/transactions/tx-search";
import { TxView } from "@/components/transactions/tx-view";
import type { TxFilters } from "@/components/transactions/types";
import { PageHeader } from "@/components/ui-kit/page-header";
import { PeriodBar } from "@/components/ui-kit/period-bar";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { otherParams, resolvePagePeriod } from "@/lib/page-period";
import { getToday } from "@/lib/settings";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function positiveId(v: string | undefined): number | undefined {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t.transactions.title} · yomi` };
}

export default async function TransactionsPage({ searchParams }: PageProps<"/transactions">) {
  const sp = await searchParams;
  const { t } = await getI18n();
  const db = await getDb();
  const user = getCurrentUser();
  const [today, months] = await Promise.all([getToday(), listMonths(db, user)]);

  // Default: the latest month with data. `?preset=`, `?from=&to=` or `?month=` (alias) pick another period.
  const latest = months[0]?.month;
  const { range, error, typed } = resolvePagePeriod(sp, today, monthRangeOf(latest ?? today.slice(0, 7)), t);
  const oneMonth = wholeMonths(range) === 1;

  const filters: TxFilters = {
    q: first(sp.q)?.trim() ?? "",
    categoryId: positiveId(first(sp.categoryId)),
    participantId: positiveId(first(sp.participantId)),
    uncategorized: ["1", "true"].includes(first(sp.uncategorized) ?? ""),
    unsplit: ["1", "true"].includes(first(sp.unsplit) ?? ""),
    showAll: first(sp.show) === "all",
  };

  const filtered = Boolean(filters.q || filters.categoryId || filters.participantId || filters.uncategorized || filters.unsplit);
  const [page, periodTotal, totals, participants, categories, autoSplitRules, allBalances, reviewCount] = await Promise.all([
    listTransactions(db, user, {
      ...range,
      q: filters.q || undefined,
      categoryId: filters.categoryId,
      participantId: filters.participantId,
      uncategorized: filters.uncategorized || undefined,
      unsplit: filters.unsplit || undefined,
      limit: 5000,
    }),
    // Unfiltered, the list's own total already says whether the period has rows.
    filtered ? listTransactions(db, user, { ...range, limit: 1 }).then((p) => p.total) : null,
    rangeTotalsForList(db, user, range.from, range.to),
    listParticipants(db, user),
    listCategories(db, user),
    listMerchantRules(db, user, { autoSplitOnly: true }),
    filters.participantId ? balances(db, user) : [],
    countReview(db, user, { today }),
  ]);
  const items = filters.showAll ? page.items : page.items.filter((t) => t.status === "ok" && t.duplicateOfId == null);

  return (
    <>
      <PageHeader
        title={t.transactions.title}
        controls={<PeriodBar path="/transactions" range={range} today={today} keep={otherParams(sp)} error={error} typed={typed} />}
        actions={
          <div className="flex w-full items-center gap-2 md:w-auto">
            <TxSearch q={filters.q} />
            <AddButton />
          </div>
        }
      />
      <TxView
        month={oneMonth ? range.from.slice(0, 7) : `${range.from}~${range.to}`}
        isRange={!oneMonth}
        monthHasData={(periodTotal ?? page.total) > 0}
        items={items}
        hiddenCount={page.items.length - items.length}
        totals={totals}
        participants={participants}
        categories={categories.filter((c) => !c.archivedAt)}
        filters={filters}
        autoSplitMerchants={autoSplitRules.map((r) => r.merchant)}
        balances={allBalances.filter((b) => b.participantId === filters.participantId)}
        today={today}
        reviewCount={reviewCount}
      />
    </>
  );
}
