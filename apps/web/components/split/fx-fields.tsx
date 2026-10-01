"use client";

import { convertByRate, normalizeRate, rateFromAmounts } from "@yomi/core/money";
import { useEffect } from "react";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { AmountInput, Field, NativeSelect, toInput, toMinor } from "./ui";

/** Currencies offered for what actually changed hands: the ledger's, then the major ones. */
export const MAJOR_CURRENCIES = ["USD", "CNY", "HKD", "EUR", "GBP", "JPY"] as const;

export function fxCurrencyOptions(base: string, ledger: readonly string[] = []): string[] {
  return [...new Set([base, ...ledger, ...MAJOR_CURRENCIES])];
}

export interface FxState {
  currency: string;
  amount: string;
  rate: string;
  /** The field the user typed last; the other one is derived from it. */
  last: "amount" | "rate";
}

export function initialFx(base: string): FxState {
  return { currency: base, amount: "", rate: "", last: "amount" };
}

/** Body fields for the API; `sign` +1 when they pay me, -1 when I pay them. `invalid` blocks submitting. */
export function fxPayload(
  fx: FxState,
  base: string,
  sign: 1 | -1,
): { invalid: boolean; body: { originalAmountMinor?: number; originalCurrency?: string; fxRate?: string } } {
  if (fx.currency === base || (!fx.amount.trim() && !fx.rate.trim())) return { invalid: false, body: {} };
  const minor = toMinor(fx.amount, fx.currency);
  const rate = normalizeRate(fx.rate);
  if (minor === null || minor <= 0 || rate === null) return { invalid: true, body: {} };
  return { invalid: false, body: { originalAmountMinor: sign * minor, originalCurrency: fx.currency, fxRate: rate } };
}

/** Fills the field the user did not type last from the one they did. */
export function deriveFx(fx: FxState, baseMinor: number, base: string): FxState {
  if (fx.currency === base || baseMinor <= 0) return fx;
  if (fx.last === "amount") {
    const minor = toMinor(fx.amount, fx.currency);
    const rate = minor && minor > 0 ? rateFromAmounts(baseMinor, base, minor, fx.currency) : null;
    return { ...fx, rate: rate ?? (fx.amount.trim() ? fx.rate : "") };
  }
  const rate = normalizeRate(fx.rate);
  if (!rate) return { ...fx, amount: fx.rate.trim() ? fx.amount : "" };
  try {
    return { ...fx, amount: toInput(convertByRate(baseMinor, base, rate, fx.currency), fx.currency) };
  } catch {
    return fx;
  }
}

/**
 * "Actually received / paid": a currency (the balance's own by default, meaning no conversion), then the amount in
 * that currency or the rate (that currency per 1 of the balance's); typing one fills the other from `baseMinor`.
 */
export function FxFields({
  baseMinor,
  base,
  incoming,
  currencies,
  value,
  onChange,
}: {
  /** Magnitude of the settlement in the balance currency. */
  baseMinor: number;
  base: string;
  incoming: boolean;
  currencies: readonly string[];
  value: FxState;
  onChange: (next: FxState) => void;
}) {
  const t = useT();
  const fx = t.split.fx;
  const other = value.currency !== base;

  // The base amount can change (choosing items): keep the rate and recompute the amount, or the other way round
  // when there is no rate yet.
  useEffect(() => {
    const next = deriveFx({ ...value, last: normalizeRate(value.rate) ? "rate" : "amount" }, baseMinor, base);
    if (next.amount !== value.amount || next.rate !== value.rate) onChange(next);
  }, [baseMinor]);

  const minor = toMinor(value.amount, value.currency);
  const amountBad = other && value.amount.trim() !== "" && (minor === null || minor <= 0);
  const rateBad = other && value.rate.trim() !== "" && normalizeRate(value.rate) === null;

  return (
    <div className="grid gap-2" data-testid="fx-fields">
      <Field label={incoming ? fx.received : fx.paid} hint={other ? undefined : fmt(fx.sameHint, { currency: base })}>
        <div className="flex gap-2">
          <NativeSelect
            value={value.currency}
            onChange={(e) => onChange(deriveFx({ ...value, currency: e.target.value }, baseMinor, base))}
            className={other ? "w-24" : "w-full sm:w-44"}
            aria-label={fx.currency}
          >
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c === base ? fmt(fx.same, { currency: c }) : c}
              </option>
            ))}
          </NativeSelect>
          {other && (
            <AmountInput
              value={value.amount}
              onChange={(e) => onChange(deriveFx({ ...value, amount: e.target.value, last: "amount" }, baseMinor, base))}
              placeholder="0.00"
              aria-label={fmt(fx.amount, { currency: value.currency })}
              aria-invalid={amountBad}
            />
          )}
        </div>
      </Field>
      {other && (
        <label className="flex items-center gap-2">
          <AmountInput
            value={value.rate}
            onChange={(e) => onChange(deriveFx({ ...value, rate: e.target.value, last: "rate" }, baseMinor, base))}
            placeholder="7.2"
            className="w-32"
            aria-label={fmt(fx.rateAria, { currency: value.currency, base })}
            aria-invalid={rateBad}
          />
          <span className="text-meta text-2">{fmt(fx.rate, { currency: value.currency, base })}</span>
        </label>
      )}
      {other && <p className="text-meta text-2">{amountBad ? t.common.badAmount : rateBad ? fx.rateInvalid : fx.hint}</p>}
    </div>
  );
}
