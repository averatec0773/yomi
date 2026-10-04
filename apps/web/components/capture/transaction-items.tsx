"use client";

import type { Category, OwnTransferItem, RepaymentReviewItem, ReviewRow, TransactionReviewBody } from "@yomi/contracts";
import { type ReactNode, useState } from "react";
import { Money, moneyText } from "@/components/money";
import { NativeSelect } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { fmt, plural } from "@/i18n";
import { accountLabel } from "@/i18n/accounts";
import { categoryLabel } from "@/i18n/categories";
import { useLocale, useT } from "@/i18n/client";
import { dayLabel } from "@/lib/month";

// Review items about ledger rows: a friend paying me back (repayment) and money between my own accounts (own_transfer).
// Same layout as the capture items in review-sheet.tsx: title and meta line, the evidence, reason chips, actions.

type Act = (body: TransactionReviewBody, message: string) => void;

/** "Bank of America CSV · BoA checking · Sep 10 · +$30.00": where the row came from, its day and amount. */
function RowMeta({ row }: { row: ReviewRow }) {
  const t = useT();
  const locale = useLocale();
  const parts = [
    t.transactions.sources[row.source as keyof typeof t.transactions.sources] ?? row.source,
    row.accountName ? accountLabel(row.accountName, t) : null,
    row.merchant,
    dayLabel(row.occurredOn, locale),
  ];
  return (
    <p className="text-meta text-2">
      {parts.filter(Boolean).join(" · ")} · <Money minor={row.amountMinor} currency={row.currency} sign="inflow" />
    </p>
  );
}

function Chips({ chips }: { chips: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span key={chip} className="rounded-full bg-tile px-2 py-0.5 text-hint text-2">
          {chip}
        </span>
      ))}
    </span>
  );
}

function Shell({
  type,
  title,
  row,
  select,
  children,
  actions,
}: {
  type: string;
  title: string;
  row: ReviewRow;
  select?: ReactNode;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-line-soft px-4 py-4 last:border-b-0 sm:px-5" data-testid="review-item" data-type={type}>
      <div className="flex items-start gap-3">
        {select}
        <div className="flex min-w-0 flex-col gap-0.5 md:flex-row md:flex-wrap md:items-baseline md:gap-x-2.5">
          <h3 className="text-body font-semibold">{title}</h3>
          <RowMeta row={row} />
        </div>
      </div>
      {children}
      <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
    </section>
  );
}

/** The income category to keep the row in: its own when it is one, else Other income. */
function useIncomeChoice(row: ReviewRow, categories: Category[]) {
  const fallback = categories.find((c) => c.key === "otherIncome") ?? categories[0];
  return useState<number | undefined>(categories.some((c) => c.id === row.categoryId) ? row.categoryId! : fallback?.id);
}

function IncomeSelect({ value, onChange, categories, label }: { value: number | undefined; onChange: (id: number) => void; categories: Category[]; label: string }) {
  const t = useT();
  return (
    <NativeSelect value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="h-8 w-auto text-meta">
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {categoryLabel(c.name, t)}
        </option>
      ))}
    </NativeSelect>
  );
}

/**
 * A transfer in that looks like a friend paying back: who it settles with, the items it pays, what stays open after
 * it, why (chips). Settle records it (with those items); Not a repayment keeps it as income in the chosen category.
 */
export function RepaymentItem({
  item,
  busy,
  selecting,
  incomeCategories,
  onAct,
}: {
  item: RepaymentReviewItem;
  busy: boolean;
  selecting: boolean;
  incomeCategories: Category[];
  onAct: Act;
}) {
  const t = useT();
  const s = t.capture.sheet;
  const r = s.repay;
  const locale = useLocale();
  const p = item.proposal;
  const [categoryId, setCategoryId] = useIncomeChoice(item.row, incomeCategories);
  const chips = p.reasons.flatMap((x) =>
    x === "time" ? [] : [x === "items" ? plural(r.reasons.items, p.itemTransactionIds.length) : r.reasons[x]],
  );
  const category = incomeCategories.find((c) => c.id === categoryId);
  return (
    <Shell
      type="repayment"
      title={s.types.repayment}
      row={item.row}
      select={selecting && <input type="checkbox" disabled aria-label={s.selectItem} className="hit relative mt-1 size-4 shrink-0 accent-[var(--brand)]" />}
      actions={
        <>
          <IncomeSelect value={categoryId} onChange={setCategoryId} categories={incomeCategories} label={r.keepAs} />
          <Button
            size="sm"
            disabled={busy || categoryId === undefined}
            onClick={() => onAct({ action: "income", categoryId }, fmt(s.toasts.income, { category: category ? categoryLabel(category.name, t) : "" }))}
          >
            {r.notRepayment}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() =>
              onAct(
                { action: "settle", participantId: p.participantId, itemTransactionIds: p.itemTransactionIds, amountMinor: p.amountMinor, currency: p.currency },
                fmt(s.toasts.settle, { name: p.participantName }),
              )
            }
          >
            {r.settle}
          </Button>
        </>
      }
    >
      <p className="text-meta">{fmt(r.settlesWith, { name: p.participantName, amount: moneyText(p.amountMinor, p.currency) })}</p>
      {p.items.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-meta text-2" aria-label={r.pays}>
          {p.items.map((x) => (
            <li key={x.transactionId} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{[x.merchant, dayLabel(x.date, locale)].filter(Boolean).join(" · ")}</span>
              <Money minor={x.remainingMinor} currency={p.currency} />
            </li>
          ))}
        </ul>
      )}
      <p className="text-meta text-2">
        {p.balanceAfterMinor === 0
          ? fmt(r.afterSettled, { name: p.participantName })
          : fmt(r.afterOpen, { name: p.participantName, amount: moneyText(p.balanceAfterMinor, p.currency) })}
      </p>
      {p.possiblyCovered && (
        <p className="text-meta text-2">
          {fmt(t.split.candidates.possiblyCovered, { amount: moneyText(p.possiblyCovered.amountMinor, p.possiblyCovered.currency), date: dayLabel(p.possiblyCovered.settledOn, locale) })}
        </p>
      )}
      <Chips chips={chips} />
    </Shell>
  );
}

/**
 * A row that looks like money between my own accounts: the two accounts when the other leg is in the ledger, else what
 * points to it, and why (chips). It's a transfer confirms it (both legs); Not a transfer keeps the row as it is, or
 * for money in the bank typed as a transfer, books it as income in the chosen category. Selectable for bulk confirm.
 */
export function TransferItem({
  item,
  busy,
  selecting,
  checked,
  onCheck,
  incomeCategories,
  onAct,
}: {
  item: OwnTransferItem;
  busy: boolean;
  selecting: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  incomeCategories: Category[];
  onAct: Act;
}) {
  const t = useT();
  const s = t.capture.sheet;
  const o = s.own;
  const p = item.proposal;
  const toIncome = item.row.kind === "transfer" && item.row.amountMinor > 0;
  const [categoryId, setCategoryId] = useIncomeChoice(item.row, incomeCategories);
  const account = (r: ReviewRow) => (r.accountName ? accountLabel(r.accountName, t) : r.merchant);
  const chips = p.reasons.map((x) => (x === "pair" && item.peer ? fmt(o.reasons.pair, { account: account(item.peer) }) : x === "pair" ? o.rules.pair : o.reasons[x]));
  const category = incomeCategories.find((c) => c.id === categoryId);
  return (
    <Shell
      type="own_transfer"
      title={s.types.own_transfer}
      row={item.row}
      select={
        selecting && (
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
            aria-label={s.selectItem}
            className="hit relative mt-1 size-4 shrink-0 cursor-pointer accent-[var(--brand)]"
          />
        )
      }
      actions={
        <>
          {toIncome && <IncomeSelect value={categoryId} onChange={setCategoryId} categories={incomeCategories} label={o.keepAs} />}
          <Button
            size="sm"
            disabled={busy || (toIncome && categoryId === undefined)}
            onClick={() =>
              toIncome
                ? onAct({ action: "income", categoryId }, fmt(s.toasts.income, { category: category ? categoryLabel(category.name, t) : "" }))
                : onAct({ action: "dismiss" }, s.toasts.dismiss)
            }
          >
            {o.notTransfer}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onAct({ action: "own_transfer" }, s.toasts.own_transfer)}>
            {o.confirm}
          </Button>
        </>
      }
    >
      <p className="text-meta">
        {item.peer
          ? fmt(o.between, { from: account(item.peer), to: account(item.row) })
          : o.rules[p.rule]}
      </p>
      <Chips chips={chips} />
    </Shell>
  );
}
