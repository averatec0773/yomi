"use client";

import type { Category, CategoryList, QuickAccount, QuickAccountList, QuickIncomeBody, QuickRowsCreated, QuickTransferBody } from "@yomi/contracts";
import { formatMinor } from "@yomi/core/money";
import { ArrowLeftRightIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { AmountInput, currencyOptions, Field, NativeSelect, TextInput, toMinor } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { fmt } from "@/i18n";
import { accountLabel } from "@/i18n/accounts";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";

// Quick add's Income and Transfer forms (the Expense mode is the text palette in quick-add.tsx).

/** My accounts and, for income, the income categories that are not archived; loaded when the form opens. */
function useEntryData(withCategories: boolean) {
  const [accounts, setAccounts] = useState<QuickAccount[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  useEffect(() => {
    void apiFetch<QuickAccountList>("/quick/accounts", { silent: true })
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
    if (withCategories) {
      void apiFetch<CategoryList>("/categories", { silent: true })
        .then((r) => setCategories(r.categories.filter((c) => c.kind === "income" && !c.archivedAt)))
        .catch(() => setCategories([]));
    }
  }, [withCategories]);
  return { accounts, categories };
}

function AccountOptions({ accounts }: { accounts: QuickAccount[] }) {
  const t = useT();
  return accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {accountLabel(a.name, t)} ({a.currency})
    </option>
  ));
}

/** The form body and the footer with its one primary button, in the quick-add dialog's layout. */
function EntryForm({ onSubmit, children, action, hint }: { onSubmit: () => void; children: ReactNode; action: ReactNode; hint?: ReactNode }) {
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-3 px-4 py-4">{children}</div>
      <div className="flex items-center justify-between gap-3 border-t border-border bg-sunken/60 px-4 py-2 text-meta text-2">
        <span>{hint}</span>
        {action}
      </div>
    </form>
  );
}

/** Income typed by hand: amount, an income category, date, the account it arrived in (or none) and an optional note. */
export function IncomeForm({ today }: { today: string }) {
  const t = useT();
  const q = t.quickAdd;
  const router = useRouter();
  const { accounts, categories } = useEntryData(true);
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [cur, setCur] = useState("USD");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const account = accounts?.find((a) => a.id === accountId);
  const currency = account?.currency ?? cur;
  const category = categoryId ?? categories[0]?.id ?? null;
  const minor = toMinor(amount, currency);
  const invalid = amount.trim() !== "" && (minor === null || minor <= 0);

  async function save() {
    if (saving || minor === null || minor <= 0 || category === null || accounts === null) return;
    setSaving(true);
    try {
      const body: QuickIncomeBody = { amountMinor: minor, currency, categoryId: category, date, accountId: account?.id ?? null, note: note.trim() || null };
      await apiFetch<QuickRowsCreated>("/quick/income", { json: body });
      toast.success(fmt(q.income.saved, { amount: formatMinor(minor, currency) }), { description: note.trim() || undefined });
      setAmount("");
      setNote("");
      router.refresh();
    } catch {
      /* apiFetch already toasted the server message */
    } finally {
      setSaving(false);
    }
  }

  return (
    <EntryForm
      onSubmit={() => void save()}
      action={
        <Button type="submit" size="sm" variant="primary" disabled={saving || minor === null || minor <= 0 || category === null || accounts === null}>
          <PlusIcon aria-hidden />
          {q.income.save}
        </Button>
      }
    >
      <Field label={t.common.amount} hint={invalid ? t.common.badAmount : undefined}>
        <div className="flex gap-2">
          {account ? (
            <span className="inline-flex h-9 w-16 shrink-0 items-center text-body text-2">{currency}</span>
          ) : (
            <NativeSelect value={cur} onChange={(e) => setCur(e.target.value)} className="w-24" aria-label={t.common.currency}>
              {currencyOptions(accounts?.map((a) => a.currency)).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          )}
          <AmountInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus aria-invalid={invalid} />
        </div>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={q.income.category}>
          <NativeSelect value={category ?? ""} onChange={(e) => setCategoryId(Number(e.target.value))}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {categoryLabel(c.name, t)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t.common.date}>
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
      </div>
      <Field label={q.income.account}>
        <NativeSelect value={account?.id ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{q.income.noAccount}</option>
          <AccountOptions accounts={accounts ?? []} />
        </NativeSelect>
      </Field>
      <Field label={t.common.noteOptional}>
        <TextInput value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={q.income.notePlaceholder} />
      </Field>
    </EntryForm>
  );
}

/** Money moved between two of my accounts: from, to, amount (the accounts' currency) and date. */
export function TransferForm({ today }: { today: string }) {
  const t = useT();
  const q = t.quickAdd;
  const router = useRouter();
  const { accounts } = useEntryData(false);
  const [fromId, setFromId] = useState<number | null>(null);
  const [toId, setToId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [saving, setSaving] = useState(false);

  const list = accounts ?? [];
  const from = list.find((a) => a.id === fromId) ?? list[0];
  const to = list.find((a) => a.id === toId) ?? list.find((a) => a.id !== from?.id && a.currency === from?.currency) ?? list.find((a) => a.id !== from?.id);
  const currency = from?.currency ?? "USD";
  const minor = toMinor(amount, currency);
  const invalid = amount.trim() !== "" && (minor === null || minor <= 0);
  const problem = !from || !to ? q.transfer.needTwo : from.id === to.id ? q.transfer.sameAccount : from.currency !== to.currency ? q.transfer.currencyMismatch : null;

  async function save() {
    if (saving || problem || !from || !to || minor === null || minor <= 0) return;
    setSaving(true);
    try {
      const body: QuickTransferBody = { fromAccountId: from.id, toAccountId: to.id, amountMinor: minor, date };
      await apiFetch<QuickRowsCreated>("/quick/transfer", { json: body });
      toast.success(fmt(q.transfer.saved, { amount: formatMinor(minor, currency) }), {
        description: `${accountLabel(from.name, t)} → ${accountLabel(to.name, t)}`,
      });
      setAmount("");
      router.refresh();
    } catch {
      /* toasted */
    } finally {
      setSaving(false);
    }
  }

  return (
    <EntryForm
      onSubmit={() => void save()}
      hint={accounts !== null && problem}
      action={
        <Button type="submit" size="sm" variant="primary" disabled={saving || problem !== null || minor === null || minor <= 0}>
          <ArrowLeftRightIcon aria-hidden />
          {q.transfer.save}
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={q.transfer.from}>
          <NativeSelect value={from?.id ?? ""} onChange={(e) => setFromId(Number(e.target.value))}>
            <AccountOptions accounts={list} />
          </NativeSelect>
        </Field>
        <Field label={q.transfer.to}>
          <NativeSelect value={to?.id ?? ""} onChange={(e) => setToId(Number(e.target.value))}>
            <AccountOptions accounts={list} />
          </NativeSelect>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.common.amount} hint={invalid ? t.common.badAmount : undefined}>
          <div className="flex gap-2">
            <span className="inline-flex h-9 w-12 shrink-0 items-center text-body text-2">{currency}</span>
            <AmountInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus aria-invalid={invalid} />
          </div>
        </Field>
        <Field label={t.common.date}>
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
      </div>
    </EntryForm>
  );
}
