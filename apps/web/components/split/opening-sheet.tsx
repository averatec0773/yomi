"use client";

import { CalendarCheckIcon, FlagIcon } from "lucide-react";
import type { ClearBeforeBody, OpeningBalanceBody, Settlement } from "@yomi/contracts";
import { useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { moneyText } from "@/components/money";
import { DialogClose } from "@/components/ui/dialog";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { Segmented } from "@/components/ui-kit/segmented";
import { settlementToast } from "./undo-toast";
import { AmountInput, currencyOptions, Field, NativeSelect, Sheet, SheetActions, TextInput, toMinor, useMutation } from "./ui";

/** "Opening balance": where the account stood before anything was recorded here. */
export function OpeningBalanceSheet({
  participantId,
  name,
  currencies,
  today,
  onDone,
}: {
  participantId: number;
  name: string;
  currencies: string[];
  today: string;
  onDone: () => void;
}) {
  const { run, busy, refresh } = useMutation();
  const t = useT();
  const ot = t.split.opening;
  const [dir, setDir] = useState<OpeningBalanceBody["direction"]>("they_owe_me");
  const [amount, setAmount] = useState("");
  const options = currencyOptions(currencies);
  const [cur, setCur] = useState(options[0]!);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");

  const minor = toMinor(amount, cur);
  const invalid = amount.trim() !== "" && (minor === null || minor <= 0);

  async function submit() {
    if (!minor || minor <= 0) return;
    const body: OpeningBalanceBody = { participantId, direction: dir, amountMinor: minor, currency: cur, date, note: note.trim() || null };
    const s = await run(() => apiFetch<Settlement>("/split/opening-balance", { json: body }));
    if (s) {
      settlementToast(
        fmt(dir === "they_owe_me" ? ot.toastToSettle : ot.toastYouPay, { name, amount: moneyText(minor, cur) }),
        s,
        refresh,
      );
      onDone();
    }
  }

  return (
    <Sheet
      title={fmt(ot.title, { name })}
      description={ot.description}
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Segmented
          label={t.split.direction}
          value={dir}
          onChange={setDir}
          options={[
            { value: "they_owe_me", label: fmt(ot.theyPayMe, { name }) },
            { value: "i_owe_them", label: fmt(ot.iPay, { name }) },
          ]}
        />
        <Field label={t.common.amount} hint={invalid ? t.common.badAmount : undefined}>
          <div className="flex gap-2">
            <NativeSelect value={cur} onChange={(e) => setCur(e.target.value)} className="w-24" aria-label={t.common.currency}>
              {options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
            <AmountInput
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
              aria-label={ot.amountLabel}
              aria-invalid={invalid}
            />
          </div>
        </Field>
        <Field label={t.common.date} hint={ot.dateHint}>
          <TextInput type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label={t.common.note}>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder={ot.notePlaceholder} />
        </Field>
        <SheetActions>
          <DialogClose asChild>
            <Button variant="ghost">{t.common.cancel}</Button>
          </DialogClose>
          <Button variant="primary" type="submit" disabled={busy || !minor || minor <= 0 || !date}>
            <FlagIcon aria-hidden />
            {busy ? t.common.recording : ot.submit}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}

/** "Start from a date, square before it": settles everything dated before the day, later items stay open. */
export function ClearBeforeSheet({
  participantId,
  name,
  currencies,
  today,
  onDone,
}: {
  participantId: number;
  name: string;
  currencies: string[];
  today: string;
  onDone: () => void;
}) {
  const { run, busy, refresh } = useMutation();
  const t = useT();
  const ct = t.split.clear;
  const options = currencyOptions(currencies);
  const [cur, setCur] = useState(options[0]!);
  const [from, setFrom] = useState(today);

  async function submit() {
    const body: ClearBeforeBody = { participantId, currency: cur, from, note: fmt(ct.note, { date: from }) };
    const s = await run(() => apiFetch<Settlement>("/split/clear-before", { json: body }));
    if (s) {
      settlementToast(fmt(ct.toast, { date: from, name, currency: cur }), s, refresh);
      onDone();
    }
  }

  return (
    <Sheet
      title={fmt(ct.title, { name })}
      description={ct.description}
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid grid-cols-[6rem_1fr] gap-2">
          <Field label={t.common.currency}>
            <NativeSelect value={cur} onChange={(e) => setCur(e.target.value)} aria-label={t.common.currency}>
              {options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={ct.from}>
            <TextInput type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} required />
          </Field>
        </div>
        <SheetActions>
          <DialogClose asChild>
            <Button variant="ghost">{t.common.cancel}</Button>
          </DialogClose>
          <Button variant="primary" type="submit" disabled={busy || !from}>
            <CalendarCheckIcon aria-hidden />
            {busy ? t.common.recording : ct.submit}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
