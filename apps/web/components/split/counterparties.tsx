"use client";

import type { ClaimCounterpartyBody, ClaimCounterpartyResult, UnclaimedCounterparty } from "@yomi/contracts";
import { EyeOffIcon, LinkIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { moneyText } from "@/components/money";
import { apiFetch } from "@/lib/api";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import type { Dictionary } from "@/i18n/en";
import { dayLabel } from "@/lib/month";
import type { Person } from "./candidates";
import { KindIcon } from "./identity-kinds";
import { NativeSelect, Section, TextInput, useMutation } from "./ui";

const SHOW = 5;

/** "2 in ¥50.00 · 1 out $12.00"; amounts per currency joined with "+", never summed across. */
function flowText(c: UnclaimedCounterparty, t: Dictionary): string {
  const parts: string[] = [];
  const ins = c.totals.filter((x) => x.inMinor > 0).map((x) => moneyText(x.inMinor, x.currency));
  const outs = c.totals.filter((x) => x.outMinor > 0).map((x) => moneyText(x.outMinor, x.currency));
  if (c.inCount > 0) parts.push(plural(t.split.counterparties.transfersIn, c.inCount, { amounts: ins.join(" + ") }));
  if (c.outCount > 0) parts.push(plural(t.split.counterparties.transfersOut, c.outCount, { amounts: outs.join(" + ") }));
  return parts.join(" · ");
}

function CounterpartyRow({ c, people }: { c: UnclaimedCounterparty; people: Person[] }) {
  const { run, busy } = useMutation();
  const t = useT();
  const locale = useLocale();
  const cp = t.split.counterparties;
  const kindLabel = t.split.kinds[c.kind];
  const [pid, setPid] = useState<number | null>(c.suggestedParticipantId ?? people[0]?.id ?? null);
  const [creating, setCreating] = useState(people.length === 0);
  const [name, setName] = useState("");
  const person = people.find((p) => p.id === pid) ?? null;
  const label = fmt(cp.label, { value: c.value, kind: kindLabel });

  async function claim(body: ClaimCounterpartyBody, who: string) {
    const out = await run(() => apiFetch<ClaimCounterpartyResult>("/split/counterparties/claim", { json: body }));
    if (out) toast.success(fmt(cp.claimed, { label, name: who }));
  }

  return (
    <li className="border-t border-line-soft py-3" aria-label={c.value}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <KindIcon kind={c.kind} className="self-center" />
          <span className="truncate text-body text-foreground">{c.value}</span>
          <span className="shrink-0 text-meta text-2">{kindLabel}</span>
          {c.account && <span className="truncate text-meta text-3">{c.account}</span>}
        </div>
        <span className="shrink-0 text-meta text-2">{fmt(cp.lastAt, { date: dayLabel(c.lastAt, locale) })}</span>
      </div>
      <p className="mt-0.5 text-meta text-2">{flowText(c, t)}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {creating ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim() || c.value;
              void claim({ kind: c.kind, value: c.value, newParticipantName: n }, n);
            }}
          >
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={c.value}
              aria-label={fmt(cp.nameAria, { value: c.value })}
              className="h-7 w-36 text-meta"
              autoFocus={people.length > 0}
            />
            <Button variant="soft" size="sm" type="submit" disabled={busy}>
              <UserPlusIcon aria-hidden />
              {cp.createAndLink}
            </Button>
            {people.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                {t.common.cancel}
              </Button>
            )}
          </form>
        ) : (
          <>
            <Button
              variant="soft"
              size="sm"
              disabled={!person || busy}
              onClick={() => person && void claim({ kind: c.kind, value: c.value, participantId: person.id }, person.name)}
            >
              <LinkIcon aria-hidden />
              {cp.yes}
            </Button>
            <NativeSelect
              value={pid ?? ""}
              onChange={(e) => setPid(e.target.value ? Number(e.target.value) : null)}
              className="h-7 w-auto text-meta"
              aria-label={fmt(cp.whoAria, { value: c.value })}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <UserPlusIcon aria-hidden />
              {cp.newPerson}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={async () => {
            const out = await run(() => apiFetch("/split/counterparties/ignore", { json: { kind: c.kind, value: c.value } }));
            if (out) toast(fmt(cp.ignored, { label }));
          }}
        >
          <EyeOffIcon aria-hidden />
          {t.common.ignore}
        </Button>
      </div>
    </li>
  );
}

/** "Who sends you money": person-to-person counterparties from the ledger that nobody has claimed yet. */
export function Counterparties({ counterparties, people }: { counterparties: UnclaimedCounterparty[]; people: Person[] }) {
  const t = useT();
  const cp = t.split.counterparties;
  const [all, setAll] = useState(false);
  if (counterparties.length === 0) return null;
  return (
    <Section
      card
      icon={<UsersIcon />}
      title={cp.title}
      aside={fmt(cp.newCount, { count: counterparties.length })}
      description={cp.description}
    >
      <ul aria-label={cp.title}>
        {(all ? counterparties : counterparties.slice(0, SHOW)).map((c) => (
          <CounterpartyRow key={`${c.kind}|${c.normalized}|${c.suggestedParticipantId}`} c={c} people={people} />
        ))}
      </ul>
      {counterparties.length > SHOW && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? t.common.collapse : plural(cp.more, counterparties.length - SHOW)}
        </Button>
      )}
    </Section>
  );
}
