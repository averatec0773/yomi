"use client";

import type { CandidateList, RecordSettlementBody, Settlement, SettlementCandidate } from "@yomi/contracts";
import { ArrowLeftRightIcon, CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { Money, moneyText } from "@/components/money";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { dayLabel } from "@/lib/month";
import { cn } from "@/lib/utils";
import type { Person } from "./candidates";
import { deriveFx, FxFields, fxCurrencyOptions, fxPayload, initialFx } from "./fx-fields";
import { Segmented } from "@/components/ui-kit/segmented";
import { settlementToast } from "./undo-toast";
import { AmountInput, currencyOptions, Field, NativeSelect, Sheet, SheetActions, TextInput, toInput, toMinor, useMutation } from "./ui";

const MAX_CANDIDATES = 5;
const WINDOW_DAYS = 7;

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86_400_000;
}

/**
 * Imported incoming transfers that could be this repayment: same person (alias match), within ±7 days,
 * and, once an amount is typed, within 10% of it in the transfer's currency. Closest first.
 */
export function matchCandidates(
  all: readonly SettlementCandidate[],
  q: { personId: number; date: string; amounts: { minor: number; currency: string }[] },
): SettlementCandidate[] {
  return all
    .filter((c) => c.amountMinor > 0 && c.suggestedParticipantId === q.personId && dayDiff(c.occurredAt, q.date) <= WINDOW_DAYS)
    .map((c) => {
      const ref = q.amounts.find((a) => a.currency === c.currency);
      const off = ref ? Math.abs(c.amountMinor - ref.minor) / ref.minor : 0;
      return { c, off, days: dayDiff(c.occurredAt, q.date) };
    })
    .filter((x) => x.off <= 0.1 || q.amounts.length === 0)
    .sort((a, b) => a.off - b.off || a.days - b.days)
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.c);
}

function TransferSheet({
  people,
  currencies,
  today,
  defaultPersonId,
  onDone,
}: {
  people: Person[];
  currencies: string[];
  today: string;
  defaultPersonId?: number;
  onDone: () => void;
}) {
  const { run, busy, refresh } = useMutation();
  const t = useT();
  const locale = useLocale();
  const tt = t.split.transfer;
  const sourceName = (s: string) => t.split.sources[s as keyof typeof t.split.sources] ?? s;
  const [dir, setDir] = useState<"in" | "out">("in");
  const [personId, setPersonId] = useState(defaultPersonId ?? people[0]!.id);
  const options = currencyOptions(currencies);
  const [cur, setCur] = useState(options[0]!);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [fx, setFx] = useState(() => initialFx(options[0]!));
  const [note, setNote] = useState("");
  const [all, setAll] = useState<SettlementCandidate[] | null>(null);
  const [linkedId, setLinkedId] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<CandidateList>("/split/candidates", { silent: true })
      .then((r) => live && setAll(r.candidates))
      .catch(() => live && setAll([]));
    return () => {
      live = false;
    };
  }, []);

  const person = people.find((p) => p.id === personId) ?? people[0]!;
  const minor = toMinor(amount, cur);
  const invalid = amount.trim() !== "" && (minor === null || minor <= 0);
  const fxOut = fxPayload(fx, cur, dir === "in" ? 1 : -1);
  const fxCur = fx.currency;
  const fxMinor = fxCur !== cur ? toMinor(fx.amount, fxCur) : null;
  const fxInvalid = fxOut.invalid;

  const amounts = [
    ...(minor && minor > 0 ? [{ minor, currency: cur }] : []),
    ...(fxMinor && fxMinor > 0 ? [{ minor: fxMinor, currency: fxCur }] : []),
  ];
  const matches = dir === "in" && all ? matchCandidates(all, { personId: person.id, date, amounts }) : [];
  const linked = matches.find((c) => c.transactionId === linkedId) ?? null;

  function pick(c: SettlementCandidate) {
    if (linkedId === c.transactionId) {
      setLinkedId(null);
      return;
    }
    setLinkedId(c.transactionId);
    setDate(c.occurredAt.slice(0, 10));
    // Fill what is still empty from the transfer itself; a transfer in another currency becomes the actual amount.
    let settleCur = cur;
    if (!amount.trim()) {
      const convert = c.suggestedCurrency !== c.currency && c.suggestedAmountMinor !== null;
      settleCur = convert ? c.suggestedCurrency : c.currency;
      setCur(settleCur);
      setAmount(toInput(convert ? c.suggestedAmountMinor! : c.amountMinor, settleCur));
    }
    if (c.currency !== settleCur && (fx.currency === settleCur || !fx.amount.trim())) {
      const base = settleCur === cur && amount.trim() ? (minor ?? 0) : c.suggestedAmountMinor ?? 0;
      setFx(deriveFx({ currency: c.currency, amount: toInput(c.amountMinor, c.currency), rate: "", last: "amount" }, base, settleCur));
    } else if (settleCur !== cur) {
      setFx(initialFx(settleCur));
    }
    if (!note.trim()) setNote(fmt(t.split.transferNote, { source: sourceName(c.source) }).trim());
  }

  async function submit() {
    if (!minor || minor <= 0 || fxInvalid) return;
    const sign = dir === "in" ? 1 : -1;
    const body: RecordSettlementBody = {
      participantId: person.id,
      amountMinor: sign * minor,
      currency: cur,
      settledOn: date,
      note: note.trim() || null,
      ...fxOut.body,
      ...(linked ? { transactionId: linked.transactionId } : {}),
    };
    const s = await run(() => apiFetch<Settlement>("/settlements", { json: body }));
    if (s) {
      settlementToast(
        fmt(dir === "in" ? tt.toastIn : tt.toastOut, { name: person.name, amount: moneyText(minor, cur) }),
        s,
        refresh,
      );
      onDone();
    }
  }

  return (
    <Sheet title={tt.title} description={tt.description}>
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
          onChange={(v) => {
            setDir(v);
            setLinkedId(null);
          }}
          options={[
            { value: "in", label: tt.theyToMe },
            { value: "out", label: tt.meToThem },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label={tt.who}>
            <NativeSelect
              value={person.id}
              onChange={(e) => {
                setPersonId(Number(e.target.value));
                setLinkedId(null);
              }}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t.common.date}>
            <TextInput type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <Field label={tt.amountLabel} hint={invalid ? t.common.badAmount : undefined}>
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
            <AmountInput
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
              aria-label={t.common.amount}
              aria-invalid={invalid}
            />
          </div>
        </Field>
        <FxFields
          baseMinor={minor && minor > 0 ? minor : 0}
          base={cur}
          incoming={dir === "in"}
          currencies={fxCurrencyOptions(cur, currencies)}
          value={fx}
          onChange={setFx}
        />
        <Field label={t.common.noteOptional}>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.split.settleAll.notePlaceholder} />
        </Field>

        {matches.length > 0 && (
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-meta text-2">{tt.matchesLegend}</legend>
            {matches.map((c) => {
              const on = linkedId === c.transactionId;
              return (
                <button
                  key={c.transactionId}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick(c)}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md border px-2.5 text-left text-body transition-colors duration-[120ms]",
                    on ? "border-primary bg-primary-soft" : "border-border hover:bg-sunken",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {c.counterparty || t.common.noName}
                    <span className="ml-2 text-meta text-2">
                      {dayLabel(c.occurredAt, locale)} · {sourceName(c.source)}
                    </span>
                  </span>
                  <Money minor={c.amountMinor} currency={c.currency} />
                </button>
              );
            })}
            <p className="text-meta text-2">
              {linked ? tt.linkedHint : tt.unlinkedHint}
            </p>
          </fieldset>
        )}

        <SheetActions>
          <DialogClose asChild>
            <Button variant="ghost">{t.common.cancel}</Button>
          </DialogClose>
          <Button variant="primary" type="submit" disabled={busy || !minor || minor <= 0 || fxInvalid || !date}>
            <CheckIcon aria-hidden />
            {busy ? t.common.recording : t.common.record}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}

/** Controlled dialog wrapper; mount it wherever a "Record transfer or repayment" entry lives. */
export function TransferDialog({
  open,
  onOpenChange,
  people,
  currencies,
  today,
  defaultPersonId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  people: Person[];
  currencies: string[];
  today: string;
  defaultPersonId?: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && people.length > 0 && (
        <TransferSheet
          people={people}
          currencies={currencies}
          today={today}
          defaultPersonId={defaultPersonId}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

/** Outline button + dialog, for page headers (/split). */
export function TransferButton(props: { people: Person[]; currencies: string[]; today: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (props.people.length === 0) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} aria-label={t.split.transfer.button}>
        <ArrowLeftRightIcon className="size-4" aria-hidden />
        <span className="max-md:hidden">{t.split.transfer.button}</span>
      </Button>
      <TransferDialog open={open} onOpenChange={setOpen} {...props} />
    </>
  );
}
