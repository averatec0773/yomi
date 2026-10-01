"use client";

import { CheckIcon, PencilIcon, TargetIcon } from "lucide-react";
import { minorDigits, parseAmountToMinor } from "@yomi/core/money";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Money, moneyText } from "@/components/money";
import { Button } from "@/components/ui-kit/button";
import { Segmented } from "@/components/ui-kit/segmented";
import { Input } from "@/components/ui/input";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import { apiFetch } from "@/lib/api";

export interface TargetEditorProps {
  month: string;
  /** The currency section this sits in (preselected when creating). */
  currency: string;
  spendingMinor: number;
  target: { amountMinor: number; currency: string; remainingMinor: number; monthSpecific: boolean } | null;
  /** A target exists in another currency (one target per month): hide the create action here. */
  otherCurrencyTarget?: boolean;
}

const CURRENCIES = ["CNY", "USD", "HKD"];

function minorToInput(minor: number, currency: string): string {
  const d = minorDigits(currency);
  const s = String(minor).padStart(d + 1, "0");
  return d === 0 ? s : `${s.slice(0, -d)}.${s.slice(-d)}`;
}

/** Target line for one currency: plain text gap, inline form to set the default or this month's target. */
export function TargetEditor({ month, currency, spendingMinor, target, otherCurrencyTarget = false }: TargetEditorProps) {
  const router = useRouter();
  const t = useT();
  const tt = t.stats.target;
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(target ? minorToInput(target.amountMinor, target.currency) : "");
  const [cur, setCur] = useState(target?.currency ?? currency);
  const [scope, setScope] = useState<"default" | "month">(target?.monthSpecific ? "month" : "default");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    let amountMinor: number;
    try {
      amountMinor = parseAmountToMinor(amount, minorDigits(cur));
      if (amountMinor < 0) throw new Error("negative");
    } catch {
      setError(tt.badAmount);
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/targets", {
        method: "PUT",
        json: { month: scope === "month" ? month : null, amountMinor, currency: cur },
      });
      toast.success(fmt(tt.set, { amount: moneyText(amountMinor, cur), scope: scope === "month" ? tt.suffixMonth : tt.suffixDefault }));
      setEditing(false);
      router.refresh();
    } catch {
      // apiFetch already toasted the server message
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-col gap-3 border-t border-border pt-4 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-6" aria-label={tt.formLabel}>
        <div className="text-meta text-2">{tt.monthly}</div>
        <div className="flex gap-2">
          <select
            aria-label={tt.currency}
            value={cur}
            onChange={(e) => setCur(e.target.value)}
            className="h-9 rounded-lg border border-border bg-surface px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {[...new Set([currency, ...CURRENCIES])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Input
            autoFocus
            inputMode="decimal"
            aria-label={tt.amount}
            placeholder="1500"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
            className="num h-9 text-left text-body"
          />
        </div>
        <Segmented
          label={tt.scope}
          value={scope}
          onChange={setScope}
          options={[
            { value: "default", label: tt.scopeDefault },
            { value: "month", label: tt.scopeMonth },
          ]}
        />
        {error && <p className="text-meta text-2">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={saving || amount.trim() === ""}>
            <CheckIcon className="size-4" aria-hidden />
            {t.common.save}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t.common.cancel}
          </Button>
        </div>
      </form>
    );
  }

  function startEditing() {
    setAmount(target ? minorToInput(target.amountMinor, target.currency) : "");
    setCur(target?.currency ?? currency);
    setScope(target?.monthSpecific ? "month" : "default");
    setError(null);
    setEditing(true);
  }

  if (!target) {
    if (otherCurrencyTarget) return null;
    return (
      <div className="flex items-start sm:justify-end">
        <Button variant="ghost" size="sm" onClick={startEditing}>
          <TargetIcon aria-hidden />
          {tt.create}
        </Button>
      </div>
    );
  }

  const over = target.remainingMinor < 0;
  const used = target.amountMinor > 0 ? Math.min(spendingMinor / target.amountMinor, 1) : 1;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-6">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-meta text-2">
          {tt.label}
          {target.monthSpecific ? tt.suffixMonth : tt.suffixDefault}
        </span>
        <Button variant="ghost" size="sm" className="-mr-2" onClick={startEditing}>
          <PencilIcon aria-hidden />
          {tt.change}
        </Button>
      </div>
      <div className="text-total font-medium">
        <Money minor={target.amountMinor} currency={target.currency} />
      </div>
      <div className="h-1 rounded-full bg-sunken" aria-hidden>
        <div className="h-full rounded-full bg-foreground/35" style={{ width: `${used * 100}%` }} />
      </div>
      <div className="text-body text-2">
        {rich(over ? tt.over : tt.left, {
          amount: <Money minor={Math.abs(target.remainingMinor)} currency={target.currency} className="text-foreground" />,
        })}
      </div>
    </div>
  );
}
