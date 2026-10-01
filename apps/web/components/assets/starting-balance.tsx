"use client";

import { FlagIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { StartingBalanceBody, StartingBalanceResult } from "@yomi/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { moneyText } from "@/components/money";
import { AmountInput, Field, NativeSelect, Sheet, SheetActions, TextInput, toInput, toMinor, useMutation } from "@/components/split/ui";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { Button, buttonClass } from "@/components/ui-kit/button";
import { fmt } from "@/i18n";
import { accountLabel } from "@/i18n/accounts";
import { useLocale, useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { dayLabel } from "@/lib/month";
import { cn } from "@/lib/utils";

export interface StartingBalanceAccount {
  id: number;
  name: string;
  currency: string;
  startingBalance: { amountMinor: number; on: string } | null;
}

/**
 * "Set a starting balance": a trigger (a quiet link row or a small button) and the md dialog. The balance is
 * the account's at the end of a day, in its currency; transactions after it are added (core
 * setStartingBalance). PUT /api/accounts/:id/starting-balance, toast, refresh.
 */
export function StartingBalance({
  accounts,
  today,
  defaultAccountId,
  label,
  variant = "link",
}: {
  accounts: StartingBalanceAccount[];
  today: string;
  defaultAccountId?: number;
  label?: string;
  variant?: "link" | "button";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (accounts.length === 0) return null;
  const text = label ?? t.assets.setStarting;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {variant === "link" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="hit relative flex h-12 w-full items-center gap-2 px-4 text-left text-body text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:px-5"
        >
          <PlusIcon className="size-4" aria-hidden />
          {text}
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={cn(buttonClass({ variant: "quiet", size: "sm" }), "text-primary")}>
          <PlusIcon aria-hidden />
          {text}
        </button>
      )}
      {open && <StartingBalanceSheet accounts={accounts} today={today} defaultAccountId={defaultAccountId} onDone={() => setOpen(false)} />}
    </Dialog>
  );
}

function StartingBalanceSheet({
  accounts,
  today,
  defaultAccountId,
  onDone,
}: {
  accounts: StartingBalanceAccount[];
  today: string;
  defaultAccountId?: number;
  onDone: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const st = t.assets.starting;
  const { run, busy } = useMutation();
  const initial = accounts.find((a) => a.id === defaultAccountId) ?? accounts[0]!;
  const [accountId, setAccountId] = useState(initial.id);
  const account = accounts.find((a) => a.id === accountId) ?? initial;
  const [amount, setAmount] = useState(initial.startingBalance ? signedInput(initial.startingBalance.amountMinor, initial.currency) : "");
  const [date, setDate] = useState(initial.startingBalance?.on ?? today);
  const minor = toMinor(amount, account.currency);
  const invalid = amount.trim() !== "" && minor === null;

  function pick(id: number) {
    const a = accounts.find((x) => x.id === id);
    if (!a) return;
    setAccountId(id);
    setAmount(a.startingBalance ? signedInput(a.startingBalance.amountMinor, a.currency) : "");
    setDate(a.startingBalance?.on ?? today);
  }

  async function save(body: StartingBalanceBody) {
    const r = await run(() => apiFetch<StartingBalanceResult>(`/accounts/${account.id}/starting-balance`, { method: "PUT", json: body }));
    if (!r) return;
    toast.success(fmt(r.startingBalance ? st.saved : st.cleared, { name: accountLabel(account.name, t) }));
    onDone();
  }

  return (
    <Sheet title={st.title} description={st.description} data-testid="starting-balance-dialog">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (minor !== null && date) void save({ amountMinor: minor, on: date });
        }}
      >
        <Field label={st.account}>
          <NativeSelect value={accountId} onChange={(e) => pick(Number(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a.name, t)} ({a.currency})
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${st.amount} (${account.currency})`} hint={invalid ? t.common.badAmount : st.amountHint}>
            <AmountInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus aria-invalid={invalid} />
          </Field>
          <Field label={st.date}>
            <TextInput type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        {account.startingBalance && (
          <p className="text-meta text-2">
            {fmt(st.current, { amount: moneyText(account.startingBalance.amountMinor, account.currency), date: dayLabel(account.startingBalance.on, locale) })}
          </p>
        )}
        <SheetActions>
          {account.startingBalance && (
            <Button variant="ghost" onClick={() => void save({ clear: true })} disabled={busy} className="mr-auto">
              <Trash2Icon aria-hidden />
              {st.clear}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost">{t.common.cancel}</Button>
          </DialogClose>
          <Button variant="primary" type="submit" disabled={busy || minor === null || !date}>
            <FlagIcon aria-hidden />
            {busy ? t.common.saving : st.submit}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}

function signedInput(minor: number, currency: string): string {
  return `${minor < 0 ? "-" : ""}${toInput(minor, currency)}`;
}
