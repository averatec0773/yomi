"use client";

import { CheckIcon } from "lucide-react";
import type { Balance, OpenItem, OpenItemList, RecordSettlementBody, Settlement, SettleAllBody } from "@yomi/contracts";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { Money, moneyText } from "@/components/money";
import { DialogClose } from "@/components/ui/dialog";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { errorText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { dayLabel, monthLabel } from "@/lib/month";
import { cn } from "@/lib/utils";
import { FxFields, fxCurrencyOptions, fxPayload, initialFx } from "./fx-fields";
import { Segmented } from "@/components/ui-kit/segmented";
import { settlementToast } from "./undo-toast";
import { AmountInput, Field, Sheet, SheetActions, TextInput, toInput, toMinor, useMutation } from "./ui";

type Scope = "all" | "items";

export function Check({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = Boolean(indeterminate);
      }}
      onChange={onChange}
      aria-label={label}
      className="size-4 shrink-0 cursor-pointer accent-[var(--brand)]"
    />
  );
}

/**
 * Items grouped by month, each month with its own select-all and each item with a checkbox. `row` lays out one
 * item around its checkbox. Shared by the settle dialog and the statement.
 */
export function MonthChecklist<T extends { transactionId: number; date: string }>({
  items,
  selected,
  onChange,
  itemLabel,
  row,
  className,
  testId,
}: {
  items: readonly T[];
  selected: ReadonlySet<number>;
  onChange: (next: Set<number>) => void;
  itemLabel: (item: T) => string;
  row: (item: T, check: ReactNode) => ReactNode;
  className?: string;
  testId?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const months = useMemo(() => {
    const m = new Map<string, T[]>();
    for (const it of items) {
      const k = it.date.slice(0, 7);
      m.set(k, [...(m.get(k) ?? []), it]);
    }
    return [...m.entries()];
  }, [items]);
  const toggle = (ids: number[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  };
  return (
    <div className={className} data-testid={testId}>
      {months.map(([month, list]) => {
        const ids = list.map((i) => i.transactionId);
        const n = ids.filter((id) => selected.has(id)).length;
        const label = monthLabel(month, locale);
        return (
          <section key={month} aria-label={label}>
            <label className="sticky top-0 z-10 flex h-9 cursor-pointer items-center gap-2.5 border-b border-line-soft bg-raised px-3 text-meta font-medium text-2">
              <Check
                checked={n === ids.length}
                indeterminate={n > 0 && n < ids.length}
                onChange={() => toggle(ids, n < ids.length)}
                label={fmt(t.split.settleAll.selectMonth, { month: label })}
              />
              {label}
            </label>
            <ul>
              {list.map((it) => (
                <li key={it.transactionId}>
                  {row(
                    it,
                    <Check
                      checked={selected.has(it.transactionId)}
                      onChange={() => toggle([it.transactionId], !selected.has(it.transactionId))}
                      label={itemLabel(it)}
                    />,
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** This person's open items in one currency, by month, each month with its own select-all. */
function ItemPicker({
  items,
  name,
  currency,
  selected,
  onChange,
}: {
  items: OpenItem[];
  name: string;
  currency: string;
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const sa = t.split.settleAll;
  return (
    <MonthChecklist
      items={items}
      selected={selected}
      onChange={onChange}
      className="max-h-[34vh] overflow-auto rounded-lg border border-border"
      testId="settle-items"
      itemLabel={(it) => `${dayLabel(it.date, locale)} ${it.merchant}`}
      row={(it, check) => (
        <label className="flex min-h-12 cursor-pointer items-center gap-2.5 border-b border-line-soft px-3 py-2 last:border-b-0">
          {check}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body">{it.merchant || t.common.noName}</span>
            <span className="truncate text-meta text-2">
              {dayLabel(it.date, locale)}
              {it.paidByThem && ` · ${fmt(sa.theyPaid, { name })}`}
              {it.status === "partial" && ` · ${fmt(sa.partOf, { amount: moneyText(Math.abs(it.deltaMinor), currency) })}`}
              {it.sharedNote && ` · ${it.sharedNote}`}
            </span>
          </span>
          <Money minor={it.remainingMinor} currency={currency} className="shrink-0 text-body" />
        </label>
      )}
    />
  );
}

/**
 * Settle with one person in one currency: everything (the exact balance) or chosen open items (their sum, which may
 * be lowered). Either way, optionally record what actually changed hands in another currency, by amount or rate.
 */
export function SettleAllSheet({
  participantId,
  name,
  balance,
  today,
  currencies = [],
  preselect,
  onDone,
}: {
  participantId: number;
  name: string;
  balance: Balance;
  today: string;
  /** Currencies in the ledger, for the FX picker. */
  currencies?: string[];
  /** Open in "Choose items" with these items ticked (from the statement's "Settle these"). */
  preselect?: readonly number[];
  onDone: () => void;
}) {
  const { run, busy, refresh } = useMutation();
  const t = useT();
  const sa = t.split.settleAll;
  const cur = balance.currency;
  const v = balance.owedToMeMinor;
  const [scope, setScope] = useState<Scope>(preselect ? "items" : "all");
  const [date, setDate] = useState(today);
  const [fx, setFx] = useState(() => initialFx(cur));
  const [note, setNote] = useState("");
  const [items, setItems] = useState<{ list: OpenItem[] | null; error?: string }>({ list: null });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (scope !== "items" || items.list !== null || items.error) return;
    let live = true;
    apiFetch<OpenItemList>(`/split/open-items?participantId=${participantId}&currency=${cur}`, { silent: true })
      .then((r) => {
        if (!live) return;
        setItems({ list: r.items });
        if (!preselect) return;
        const picked = r.items.filter((i) => preselect.includes(i.transactionId));
        const s = picked.reduce((acc, i) => acc + i.remainingMinor, 0);
        setSelected(new Set(picked.map((i) => i.transactionId)));
        setAmount(s === 0 ? "" : toInput(s, cur));
      })
      .catch((e: Error) => live && setItems({ list: null, error: errorText(e, t) }));
    return () => {
      live = false;
    };
  }, [scope, items, participantId, cur, t, preselect]);

  const sum = (items.list ?? []).filter((i) => selected.has(i.transactionId)).reduce((s, i) => s + i.remainingMinor, 0);
  const pickItems = (next: Set<number>) => {
    setSelected(next);
    const s = (items.list ?? []).filter((i) => next.has(i.transactionId)).reduce((acc, i) => acc + i.remainingMinor, 0);
    setAmount(s === 0 ? "" : toInput(s, cur));
  };
  const typed = toMinor(amount, cur);
  const itemsError =
    scope !== "items"
      ? null
      : selected.size === 0 || sum === 0
        ? sa.noneSelected
        : typed === null || typed <= 0
          ? t.common.badAmount
          : typed > Math.abs(sum)
            ? fmt(sa.amountTooHigh, { amount: moneyText(Math.abs(sum), cur) })
            : null;
  const magnitude = scope === "all" ? Math.abs(v) : itemsError ? Math.abs(sum) : typed!;
  const theyPay = scope === "all" ? v > 0 : sum >= 0;
  const fxOut = fxPayload(fx, cur, theyPay ? 1 : -1);

  async function submit() {
    if (fxOut.invalid || itemsError) return;
    const common = { settledOn: date, note: note.trim() || null, ...fxOut.body };
    if (scope === "all") {
      const body: SettleAllBody = { participantId, currency: cur, ...common };
      const s = await run(() => apiFetch<Settlement>("/split/settle-all", { json: body }));
      if (s) {
        settlementToast(fmt(sa.toast, { name, currency: cur, amount: moneyText(Math.abs(v), cur) }), s, refresh);
        onDone();
      }
      return;
    }
    const ids = [...selected];
    const body: RecordSettlementBody = {
      participantId,
      currency: cur,
      amountMinor: theyPay ? magnitude : -magnitude,
      itemTransactionIds: ids,
      ...common,
    };
    const s = await run(() => apiFetch<Settlement>("/settlements", { json: body }));
    if (s) {
      settlementToast(plural(sa.toastItems, ids.length, { name, amount: moneyText(magnitude, cur) }), s, refresh);
      onDone();
    }
  }

  return (
    <Sheet
      title={fmt(sa.title, { name, currency: cur })}
      description={scope === "all" ? sa.description : sa.descriptionItems}
    >
      <Segmented
        label={sa.scope}
        value={scope}
        onChange={setScope}
        options={[
          { value: "all", label: sa.scopeAll },
          { value: "items", label: sa.scopeItems },
        ]}
      />

      {scope === "all" ? (
        <div className="mt-3 rounded-md bg-sunken px-4 py-3">
          <p className="text-meta text-2">{fmt(theyPay ? sa.theyPay : sa.youPay, { name })}</p>
          <Money minor={v} currency={cur} abs className="text-total font-medium" tone={theyPay ? "default" : "neg"} />
        </div>
      ) : (
        <div className="mt-3 grid gap-3">
          {items.error ? (
            <p className="text-body text-2">{items.error}</p>
          ) : items.list === null ? (
            <p className="text-body text-3">{sa.loading}</p>
          ) : items.list.length === 0 ? (
            <p className="text-body text-2">{fmt(sa.empty, { currency: cur })}</p>
          ) : (
            <>
              <ItemPicker items={items.list} name={name} currency={cur} selected={selected} onChange={pickItems} />
              <Field
                label={`${sa.amount} · ${plural(sa.selected, selected.size)}`}
                hint={itemsError ?? fmt(sa.amountHint, { amount: moneyText(Math.abs(sum), cur) })}
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-meta text-2">{fmt(theyPay ? sa.theyPay : sa.youPay, { name })}</span>
                  <AmountInput
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    aria-label={sa.amount}
                    aria-invalid={Boolean(itemsError) && selected.size > 0}
                    className={cn(itemsError && selected.size > 0 && "border-foreground/40")}
                  />
                  <span className="shrink-0 text-meta text-2">{cur}</span>
                </div>
              </Field>
            </>
          )}
        </div>
      )}

      <form
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t.common.date}>
          <TextInput type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <FxFields
          baseMinor={magnitude}
          base={cur}
          incoming={theyPay}
          currencies={fxCurrencyOptions(cur, currencies)}
          value={fx}
          onChange={setFx}
        />
        <Field label={t.common.noteOptional}>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder={sa.notePlaceholder} />
        </Field>
        <SheetActions>
          <DialogClose asChild>
            <Button variant="ghost">{t.common.cancel}</Button>
          </DialogClose>
          <Button variant="primary" type="submit" disabled={busy || fxOut.invalid || Boolean(itemsError) || !date}>
            <CheckIcon aria-hidden />
            {busy ? t.common.recording : fmt(sa.confirm, { amount: moneyText(magnitude, cur) })}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
