"use client";

import type { Balance, MarkSettlementBody, Settlement, SettlementCandidate } from "@yomi/contracts";
import { convertFromRate, normalizeRate, rateFromAmounts } from "@yomi/core/money";
import { BanknoteIcon, CheckIcon, EyeOffIcon, InboxIcon, LandmarkIcon, MessageCircleIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { Segmented } from "@/components/ui-kit/segmented";
import { Money, moneyText } from "@/components/money";
import { apiFetch } from "@/lib/api";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import { dayLabel } from "@/lib/month";
import { useSessionDismissed } from "./session-dismiss";
import { settlementToast } from "./undo-toast";
import { AmountInput, NativeSelect, Section, toInput, toMinor, useMutation } from "./ui";

export interface Person {
  id: number;
  name: string;
}

const SHOW = 4;

function RepaymentHint({ name, owed }: { name: string; owed: Balance[] }) {
  const t = useT();
  if (owed.length === 0) return <span>{fmt(t.split.candidates.noDebt, { name })}</span>;
  return (
    <span>
      {rich(t.split.candidates.stillToSettle, {
        name,
        amounts: owed.map((b, i) => (
          <span key={b.currency}>
            {i > 0 && t.common.listSep}
            <Money minor={b.owedToMeMinor} currency={b.currency} className="text-foreground" />
          </span>
        )),
      })}
    </span>
  );
}

function CandidateRow({
  c,
  people,
  balances,
  rates,
  onDismiss,
}: {
  c: SettlementCandidate;
  people: Person[];
  balances: Balance[];
  /** Last rate per "balance currency|transfer currency": transfer units per 1 balance unit, decimal string. */
  rates: Record<string, string>;
  onDismiss: () => void;
}) {
  const { run, busy, refresh } = useMutation();
  const t = useT();
  const locale = useLocale();
  const ct = t.split.candidates;
  const SourceIcon = c.source === "wechat" ? MessageCircleIcon : c.source === "alipay" ? BanknoteIcon : LandmarkIcon;
  // Outgoing (I paid them back, Zelle out): recorded as a negative settlement, never converted.
  const outgoing = c.amountMinor < 0;
  const [pid, setPid] = useState<number | null>(c.suggestedParticipantId);
  const person = people.find((p) => p.id === pid) ?? null;
  const bs = balances.filter((b) => b.participantId === pid);
  const same = bs.find((b) => b.currency === c.currency);
  const other = outgoing ? undefined : bs.find((b) => b.currency !== c.currency && b.owedToMeMinor > 0);
  const owed = bs.filter((b) => b.owedToMeMinor > 0);

  const prefill = (target: Balance | undefined): string => {
    if (!target) return "";
    // The server's suggestion uses this person's own last rate, or none (then the user types it).
    if (pid !== null && pid === c.suggestedParticipantId && target.currency === c.suggestedCurrency) {
      return c.suggestedAmountMinor === null ? "" : toInput(c.suggestedAmountMinor, target.currency);
    }
    const rate = rates[`${target.currency}|${c.currency}`];
    if (!rate) return "";
    const minor = Math.min(convertFromRate(Math.abs(c.amountMinor), c.currency, rate, target.currency), target.owedToMeMinor);
    return toInput(minor, target.currency);
  };
  const rateFor = (amount: string, target: Balance | undefined): string => {
    const m = target ? toMinor(amount, target.currency) : null;
    return target && m && m > 0 ? (rateFromAmounts(m, target.currency, c.amountMinor, c.currency) ?? "") : "";
  };
  /** The rate that goes with prefill(): the last rate itself when the amount came from it, else derived. */
  const prefillRate = (target: Balance | undefined): string => {
    if (!target) return "";
    const fromServer = pid !== null && pid === c.suggestedParticipantId && target.currency === c.suggestedCurrency;
    const last = rates[`${target.currency}|${c.currency}`];
    return !fromServer && last && prefill(target) ? last : rateFor(prefill(target), target);
  };

  const defaultFx = other !== undefined && (!same || same.owedToMeMinor <= 0);
  const [fxFor, setFxFor] = useState<number | null>(defaultFx ? pid : null);
  const fx = fxFor !== null && fxFor === pid && other !== undefined;
  const [fxAmount, setFxAmountRaw] = useState(() => (defaultFx ? prefill(other) : ""));
  const [fxRate, setFxRateRaw] = useState(() => (defaultFx ? prefillRate(other) : ""));
  const setFxAmount = (v: string) => {
    setFxAmountRaw(v);
    setFxRateRaw(rateFor(v, other));
  };
  const setFxRate = (v: string) => {
    setFxRateRaw(v);
    const r = normalizeRate(v);
    if (other && r) setFxAmountRaw(toInput(convertFromRate(Math.abs(c.amountMinor), c.currency, r, other.currency), other.currency));
  };

  const fxMinor = fx ? toMinor(fxAmount, other.currency) : null;
  const rateOk = fx ? normalizeRate(fxRate) : null;
  const fxInvalid = fx && (fxMinor === null || fxMinor <= 0 || rateOk === null);
  const lastRate = other ? rates[`${other.currency}|${c.currency}`] : undefined;

  async function mark() {
    if (!person || fxInvalid) return;
    const body: MarkSettlementBody = { participantId: person.id };
    let credited = moneyText(c.amountMinor, c.currency);
    if (fx && fxMinor) {
      body.currency = other.currency;
      body.amountMinor = fxMinor;
      if (rateOk) body.fxRate = rateOk;
      credited = moneyText(fxMinor, other.currency);
    }
    const s = await run(() => apiFetch<Settlement>(`/transactions/${c.transactionId}/mark-settlement`, { json: body }));
    if (s)
      settlementToast(
        outgoing
          ? fmt(ct.toastOut, { name: person.name, amount: moneyText(-c.amountMinor, c.currency) })
          : fmt(ct.toastIn, { name: person.name, amount: credited }),
        s,
        refresh,
      );
  }

  return (
    <li className="flex flex-col gap-2 border-t border-line-soft py-3">
      <div className="flex items-center gap-2">
        <SourceIcon className="size-3.5 shrink-0 text-2" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-body text-foreground">{c.counterparty || t.common.noName}</span>
        <Money minor={c.amountMinor} currency={c.currency} sign="inflow" className="text-body font-medium" />
      </div>
      <span className="text-meta text-2">
        {dayLabel(c.occurredAt, locale)} · {t.split.sources[c.source as keyof typeof t.split.sources] ?? c.source}
        {c.sourceCategory ? ` ${c.sourceCategory}` : ""}
      </span>

      <div className="flex flex-wrap items-center gap-2">
        {c.match === "none" ? (
          <NativeSelect
            value={pid ?? ""}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              setPid(id);
              const o = balances.find((b) => b.participantId === id && b.currency !== c.currency && b.owedToMeMinor > 0);
              const s = balances.find((b) => b.participantId === id && b.currency === c.currency);
              const useFx = o !== undefined && (!s || s.owedToMeMinor <= 0);
              setFxFor(useFx ? id : null);
              setFxAmountRaw(useFx ? prefill(o) : "");
              setFxRateRaw(useFx ? prefillRate(o) : "");
            }}
            className="h-8 w-auto"
            aria-label={ct.whoLabel}
          >
            <option value="">{ct.whoPlaceholder}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        ) : null}

        {person && other && (
          <Segmented
            label={ct.currencyLabel}
            value={fx}
            options={[
              { value: false, label: fmt(ct.countAs, { currency: c.currency }) },
              { value: true, label: fmt(ct.offset, { currency: other.currency }) },
            ]}
            onChange={(v) => {
              setFxFor(v ? pid : null);
              if (v && !fxAmount) {
                setFxAmountRaw(prefill(other));
                setFxRateRaw(prefillRate(other));
              }
            }}
          />
        )}

        {fx && (
          <label className="inline-flex items-center gap-1.5 text-meta text-2">
            {ct.offsetPrefix}
            <AmountInput
              value={fxAmount}
              onChange={(e) => setFxAmount(e.target.value)}
              placeholder={other.currency === "USD" ? "$0.00" : "0.00"}
              className="h-8 w-24"
              aria-label={fmt(ct.offsetAria, { currency: other.currency })}
              aria-invalid={fxInvalid && (fxMinor === null || fxMinor <= 0)}
            />
            {other.currency}
          </label>
        )}
        {fx && (
          <label className="inline-flex items-center gap-1.5 text-meta text-2">
            <AmountInput
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
              placeholder="7.2"
              className="h-8 w-24"
              aria-label={fmt(t.split.fx.rateAria, { currency: c.currency, base: other.currency })}
              aria-invalid={fxInvalid && rateOk === null}
            />
            {fmt(t.split.fx.rate, { currency: c.currency, base: other.currency })}
          </label>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            <EyeOffIcon aria-hidden />
            {t.common.ignore}
          </Button>
          <Button
            variant="soft"
            size="sm"
            disabled={!person || busy || fxInvalid}
            onClick={() => void mark()}
          >
            <CheckIcon aria-hidden />
            {person ? fmt(outgoing ? ct.markOut : ct.markIn, { name: person.name }) : ct.mark}
          </Button>
        </div>
      </div>

      {c.possiblyCovered && pid === c.suggestedParticipantId && (
        <p className="text-meta text-2">
          {fmt(ct.possiblyCovered, {
            amount: moneyText(c.possiblyCovered.amountMinor, c.possiblyCovered.currency),
            date: dayLabel(c.possiblyCovered.settledOn, locale),
          })}
        </p>
      )}
      {person && (
        <p className="text-meta text-2">
          {outgoing ? <span>{fmt(ct.outgoingHint, { name: person.name })}</span> : <RepaymentHint name={person.name} owed={owed} />}
          {fx && (
            <span>
              {" · "}
              {fxMinor && rateOk ? t.split.fx.hint : lastRate ? fmt(ct.lastRate, { rate: lastRate }) : fmt(ct.enterFx, { currency: other.currency })}
            </span>
          )}
        </p>
      )}
    </li>
  );
}

/** "Possible repayments": incoming WeChat/Alipay/Zelle transfers that look like someone paying back, and Zelle I sent a participant. */
export function Candidates({
  candidates,
  people,
  balances,
  rates,
}: {
  candidates: SettlementCandidate[];
  people: Person[];
  balances: Balance[];
  rates: Record<string, string>;
}) {
  const t = useT();
  const [dismissed, dismiss] = useSessionDismissed("yomi.split.candidates");
  const [all, setAll] = useState(false);
  const shown = candidates.filter((c) => !dismissed.has(c.transactionId));
  if (shown.length === 0) return null;
  return (
    <Section
      card
      icon={<InboxIcon />}
      iconClassName="text-pos"
      title={t.split.candidates.title}
      count={shown.length}
      description={t.split.candidates.description}
    >
      <ul>
        {(all ? shown : shown.slice(0, SHOW)).map((c) => (
          <CandidateRow
            key={`${c.transactionId}|${c.suggestedParticipantId}|${c.suggestedCurrency}`}
            c={c}
            people={people}
            balances={balances}
            rates={rates}
            onDismiss={() => dismiss(c.transactionId)}
          />
        ))}
      </ul>
      {shown.length > SHOW && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? t.common.collapse : plural(t.common.moreRows, shown.length - SHOW)}
        </Button>
      )}
    </Section>
  );
}
