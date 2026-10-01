"use client";

import { CheckIcon } from "lucide-react";
import type { RecordSettlementBody, Settlement } from "@yomi/contracts";
import { useState } from "react";
import { Segmented } from "@/components/ui-kit/segmented";
import { Button } from "@/components/ui-kit/button";
import { moneyText } from "@/components/money";
import { DialogClose } from "@/components/ui/dialog";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { FxFields, fxCurrencyOptions, fxPayload, initialFx } from "./fx-fields";
import { settlementToast } from "./undo-toast";
import { AmountInput, currencyOptions, Field, NativeSelect, Sheet, SheetActions, TextInput, toMinor, useMutation } from "./ui";

/** A settlement with any amount: partial repayments, or money I sent them. */
export function RecordSettlementSheet({
  participantId,
  name,
  currencies,
  ledgerCurrencies,
  today,
  onDone,
}: {
  participantId: number;
  name: string;
  currencies: string[];
  /** Every currency in the ledger, for "actually received". */
  ledgerCurrencies: string[];
  today: string;
  onDone: () => void;
}) {
  const { run, busy, refresh } = useMutation();
  const t = useT();
  const rt = t.split.record;
  const [dir, setDir] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const options = currencyOptions(currencies);
  const [cur, setCur] = useState(options[0]!);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [fx, setFx] = useState(() => initialFx(options[0]!));

  const minor = toMinor(amount, cur);
  const invalid = amount.trim() !== "" && (minor === null || minor <= 0);
  const fxOut = fxPayload(fx, cur, dir === "in" ? 1 : -1);

  async function submit() {
    if (!minor || minor <= 0 || fxOut.invalid) return;
    const body: RecordSettlementBody = {
      participantId,
      amountMinor: dir === "in" ? minor : -minor,
      currency: cur,
      settledOn: date,
      note: note.trim() || null,
      ...fxOut.body,
    };
    const s = await run(() => apiFetch<Settlement>("/settlements", { json: body }));
    if (s) {
      settlementToast(
        fmt(dir === "in" ? rt.toastIn : rt.toastOut, { name, amount: moneyText(minor, cur) }),
        s,
        refresh,
      );
      onDone();
    }
  }

  return (
    <Sheet title={fmt(rt.title, { name })} description={rt.description}>
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
            { value: "in", label: fmt(rt.theyGaveMe, { name }) },
            { value: "out", label: fmt(rt.iGave, { name }) },
          ]}
        />
        <Field label={t.common.amount} hint={invalid ? t.common.badAmount : undefined}>
          <div className="flex gap-2">
            <NativeSelect
              value={cur}
              onChange={(e) => {
                setCur(e.target.value);
                setFx(initialFx(e.target.value));
              }}
              className="w-24"
              aria-label={t.common.currency}
            >
              {options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
            <AmountInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus aria-invalid={invalid} />
          </div>
        </Field>
        <Field label={t.common.date}>
          <TextInput type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <FxFields
          baseMinor={minor && minor > 0 ? minor : 0}
          base={cur}
          incoming={dir === "in"}
          currencies={fxCurrencyOptions(cur, ledgerCurrencies)}
          value={fx}
          onChange={setFx}
        />
        <Field label={t.common.noteOptional}>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder={rt.notePlaceholder} />
        </Field>
        <SheetActions>
          <DialogClose asChild>
            <Button variant="ghost">{t.common.cancel}</Button>
          </DialogClose>
          <Button variant="primary" type="submit" disabled={busy || !minor || minor <= 0 || !date || fxOut.invalid}>
            <CheckIcon aria-hidden />
            {busy ? t.common.recording : t.common.record}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
