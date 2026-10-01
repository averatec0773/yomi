import {
  balances,
  getCurrentUser,
  ledgerCurrencies,
  listCategories,
  listMerchantRules,
  listParticipants,
  listSettlements,
  listUnclaimedCounterparties,
  settlementCandidates,
  unsplitSuggestions,
  unsplitSummary,
} from "@yomi/core";
import { rateFromAmounts } from "@yomi/core/money";
import { connection } from "next/server";
import { BalanceBlock } from "@/components/split/balance-block";
import { Candidates } from "@/components/split/candidates";
import { CatchUp } from "@/components/split/catch-up";
import { Counterparties } from "@/components/split/counterparties";
import { FriendPaid } from "@/components/split/friend-paid";
import { SettlementHistory } from "@/components/split/history";
import { AddParticipant, ParticipantsPanel } from "@/components/split/participants";
import { Suggestions } from "@/components/split/suggestions";
import { TransferButton } from "@/components/split/transfer-sheet";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { PageHeader } from "@/components/ui-kit/page-header";
import { UsersIcon } from "lucide-react";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { todayLocal } from "@/lib/month";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t.split.metaTitle };
}

export default async function SplitPage() {
  await connection();
  const { t } = await getI18n();
  const db = await getDb();
  const user = getCurrentUser();
  const today = todayLocal();

  const participants = await listParticipants(db, user, { includeArchived: true });
  const others = participants.filter((p) => !p.isSelf);
  const active = others.filter((p) => p.archivedAt === null).map((p) => ({ id: p.id, name: p.name }));

  const counterparties = await listUnclaimedCounterparties(db, user);

  if (others.length === 0) {
    return (
      <div className="flex max-w-narrow flex-col gap-4">
        <PageHeader title={t.split.title} className="mb-2" />
        <EmptyState
          icon={UsersIcon}
          action={
            <div className="flex w-full flex-col gap-2">
              <AddParticipant autoFocus />
              <p className="text-meta text-2">
                {t.split.emptyBody1} {t.split.emptyBody2}
              </p>
            </div>
          }
        >
          {t.split.emptyTitle}
        </EmptyState>
        <Counterparties counterparties={counterparties} people={[]} />
      </div>
    );
  }

  const bal = await balances(db, user);
  const settlements = await listSettlements(db, user);
  const candidates = await settlementCandidates(db, user);
  const suggestions = await unsplitSuggestions(db, user);
  const unsplitMonths = await unsplitSummary(db, user);
  const autoRules = await listMerchantRules(db, user, { autoSplitOnly: true });
  const categories = (await listCategories(db, user))
    .filter((c) => c.kind === "expense" && c.archivedAt === null)
    .map((c) => ({ id: c.id, name: c.name }));

  // Most recent FX rate per (credited currency, paid currency), to prefill the offset amount on candidates.
  const rates: Record<string, string> = {};
  for (const s of settlements) {
    if (s.originalAmountMinor === null || !s.originalCurrency || s.originalCurrency === s.currency) continue;
    const key = `${s.currency}|${s.originalCurrency}`;
    if (key in rates) continue;
    const rate = s.fxRate ?? rateFromAmounts(s.amountMinor, s.currency, s.originalAmountMinor, s.originalCurrency);
    if (rate) rates[key] = rate;
  }

  const blocks = others
    .map((p) => ({ p, lines: bal.filter((b) => b.participantId === p.id) }))
    .filter(({ p, lines }) => p.archivedAt === null || lines.length > 0);
  const currencies = [...new Set(bal.map((b) => b.currency))];
  const inLedger = await ledgerCurrencies(db, user);

  return (
    <div>
      <PageHeader
        title={t.split.title}
        actions={
          <>
            <TransferButton people={active} currencies={currencies} today={today} />
            <FriendPaid people={active} categories={categories} currencies={currencies} today={today} />
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3 xl:grid-rows-[auto_1fr] xl:gap-5">
        <section aria-label={t.split.title} className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          {blocks.map(({ p, lines }) => (
            <BalanceBlock
              key={p.id}
              participantId={p.id}
              name={p.name}
              archived={p.archivedAt !== null}
              lines={lines}
              today={today}
              ledgerCurrencies={inLedger}
            />
          ))}
        </section>
        <aside className="flex min-w-0 flex-col gap-4 empty:hidden xl:col-start-3 xl:row-span-2 xl:row-start-1">
          <Candidates candidates={candidates} people={active} balances={bal} rates={rates} />
          <Counterparties counterparties={counterparties} people={active} />
        </aside>
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          <CatchUp months={unsplitMonths} />
          <Suggestions suggestions={suggestions} people={active} />
          <SettlementHistory settlements={settlements} />
          <ParticipantsPanel participants={participants} autoRules={autoRules} />
        </div>
      </div>
    </div>
  );
}
