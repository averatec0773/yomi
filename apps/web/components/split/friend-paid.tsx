"use client";

import type { CreatedEntry, FriendPaidBody } from "@yomi/contracts";
import { splitEqual } from "@yomi/core/money";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { moneyText } from "@/components/money";
import { ParticipantChip } from "@/components/participant-chip";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { fmt } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { CheckIcon, PlusIcon } from "lucide-react";
import type { Person } from "./candidates";
import { Segmented } from "@/components/ui-kit/segmented";
import { AmountInput, currencyOptions, Field, NativeSelect, Sheet, SheetActions, TextInput, toMinor, useMutation } from "./ui";

export interface CategoryOption {
  id: number;
  name: string;
}

function FriendPaidSheet({
  people,
  categories,
  currencies,
  today,
  onDone,
}: {
  people: Person[];
  categories: CategoryOption[];
  currencies: string[];
  today: string;
  onDone: () => void;
}) {
  const { run, busy } = useMutation();
  const t = useT();
  const ft = t.split.friendPaid;
  const [payerId, setPayerId] = useState(people[0]!.id);
  const [amount, setAmount] = useState("");
  const options = currencyOptions(currencies);
  const [cur, setCur] = useState(options[0]!);
  const [date, setDate] = useState(today);
  const [desc, setDesc] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [mode, setMode] = useState<"equal" | "mine">("equal");
  const [sharing, setSharing] = useState<Set<number>>(() => new Set([people[0]!.id]));

  const payer = people.find((p) => p.id === payerId)!;
  const minor = toMinor(amount, cur);
  const invalid = amount.trim() !== "" && (minor === null || minor <= 0);
  const mine =
    minor && minor > 0 ? (mode === "mine" ? minor : splitEqual(minor, sharing.size + 1)[0]!) : null;

  async function submit() {
    if (!minor || minor <= 0) return;
    const body: FriendPaidBody = {
      payerId,
      totalMinor: minor,
      currency: cur,
      occurredAt: date,
      description: desc.trim() || fmt(ft.paidDefault, { name: payer.name }),
      categoryId,
      ...(mode === "mine"
        ? { participantIds: [payerId], mode: "exact" as const, exact: [{ participantId: payerId, owedMinor: 0 }] }
        : { participantIds: [...sharing], mode: "equal" as const }),
    };
    const out = await run(() => apiFetch<CreatedEntry>("/split/friend-paid", { json: body }));
    if (out) {
      toast.success(fmt(ft.toast, { name: payer.name, amount: moneyText(minor, cur), share: moneyText(out.myShareMinor, cur) }));
      onDone();
    }
  }

  return (
    <Sheet title={ft.title} description={ft.description}>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={ft.who}>
            <NativeSelect
              value={payerId}
              onChange={(e) => {
                const id = Number(e.target.value);
                setPayerId(id);
                setSharing((s) => (s.size <= 1 ? new Set([id]) : s));
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
        <Field label={ft.total} hint={invalid ? t.common.badAmount : undefined}>
          <div className="flex gap-2">
            <NativeSelect value={cur} onChange={(e) => setCur(e.target.value)} className="w-24" aria-label={t.common.currency}>
              {options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
            <AmountInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus aria-invalid={invalid} />
          </div>
        </Field>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label={ft.what}>
            <TextInput value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={ft.whatPlaceholder} />
          </Field>
          <Field label={ft.categoryOptional}>
            <NativeSelect
              value={categoryId ?? ""}
              onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
              className="w-28"
            >
              <option value="">{ft.noCategory}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryLabel(c.name, t)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>

        <div className="grid gap-2">
          <span className="text-meta text-2">{ft.how}</span>
          <Segmented
            label={ft.how}
            value={mode}
            onChange={setMode}
            options={[
              { value: "equal", label: ft.equal },
              { value: "mine", label: ft.mine },
            ]}
          />
          {mode === "equal" && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-meta text-2">{ft.mePlus}</span>
              {people.map((p) => (
                <ParticipantChip
                  key={p.id}
                  size="md"
                  label={p.name}
                  state={sharing.has(p.id) ? "on" : "off"}
                  onToggle={(on) =>
                    setSharing((s) => {
                      const next = new Set(s);
                      if (on) next.add(p.id);
                      else next.delete(p.id);
                      return next;
                    })
                  }
                />
              ))}
            </div>
          )}
          <p className="text-meta text-2">
            {mine !== null
              ? fmt(mode === "mine" ? ft.minePay : ft.equalShare, { name: payer.name, amount: moneyText(mine, cur) })
              : mode === "mine"
                ? fmt(ft.mineNoAmount, { name: payer.name })
                : ft.equalNoAmount}
          </p>
        </div>

        <SheetActions>
          <DialogClose asChild>
            <Button variant="ghost">{t.common.cancel}</Button>
          </DialogClose>
          <Button variant="primary" type="submit" disabled={busy || !minor || minor <= 0 || !date}>
            <CheckIcon aria-hidden />
            {busy ? t.common.recording : t.common.record}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}

/** "Roommate paid for something" button + dialog, with the quick-add shortcut as a hint. */
export function FriendPaid({
  people,
  categories,
  currencies,
  today,
}: {
  people: Person[];
  categories: CategoryOption[];
  currencies: string[];
  today: string;
}) {
  const t = useT();
  const ft = t.split.friendPaid;
  const [open, setOpen] = useState(false);
  if (people.length === 0) return null;
  const first = people[0]!.name;
  return (
    <>
      <Button variant="primary" phoneSoft onClick={() => setOpen(true)} title={fmt(ft.quickHint, { name: first })}>
        <PlusIcon className="size-4" aria-hidden />
        {ft.button}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <FriendPaidSheet
            people={people}
            categories={categories}
            currencies={currencies}
            today={today}
            onDone={() => setOpen(false)}
          />
        )}
      </Dialog>
    </>
  );
}
