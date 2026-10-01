"use client";

import type { SplitResult, UnsplitSuggestion } from "@yomi/contracts";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { CategoryPill } from "@/components/category-pill";
import { Money, moneyText } from "@/components/money";
import { ParticipantChip } from "@/components/participant-chip";
import { apiFetch } from "@/lib/api";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { dayLabel } from "@/lib/month";
import type { Person } from "./candidates";
import { useSessionDismissed } from "./session-dismiss";
import { Section, useMutation } from "./ui";

const SHOW = 6;

interface Tapped {
  s: UnsplitSuggestion;
  on: number[];
  myShareMinor: number | null;
}

/** "Split these?": unsplit expenses that look shared. One tap on a chip splits it equally. */
export function Suggestions({ suggestions, people }: { suggestions: UnsplitSuggestion[]; people: Person[] }) {
  const { refresh } = useMutation();
  const t = useT();
  const locale = useLocale();
  const sg = t.split.suggestions;
  const [dismissed, dismiss] = useSessionDismissed("yomi.split.suggestions");
  const [tapped, setTapped] = useState<Map<number, Tapped>>(new Map());
  const [busy, setBusy] = useState<number | null>(null);
  const [all, setAll] = useState(false);

  const byId = new Map<number, UnsplitSuggestion>();
  for (const x of tapped.values()) byId.set(x.s.transactionId, x.s);
  for (const s of suggestions) byId.set(s.transactionId, s);
  const rows = [...byId.values()]
    .filter((s) => !dismissed.has(s.transactionId))
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : b.transactionId - a.transactionId));
  if (rows.length === 0 || people.length === 0) return null;
  const open = rows.filter((s) => !tapped.get(s.transactionId)?.on.length).length;

  async function toggle(s: UnsplitSuggestion, participantId: number) {
    setBusy(s.transactionId);
    try {
      const res = await apiFetch<SplitResult>(`/transactions/${s.transactionId}/toggle-participant`, {
        json: { participantId },
      });
      setTapped((m) =>
        new Map(m).set(s.transactionId, {
          s,
          on: res.split?.participantIds ?? [],
          myShareMinor: res.split ? res.split.myShareMinor : null,
        }),
      );
      refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section card icon={<SparklesIcon />} title={sg.title} count={open} description={sg.description}>
      <ul>
        {(all ? rows : rows.slice(0, SHOW)).map((s) => {
          const tap = tapped.get(s.transactionId);
          const on = new Set(tap?.on ?? []);
          const names = people.filter((p) => on.has(p.id)).map((p) => p.name);
          return (
            <li key={s.transactionId} className="border-t border-line-soft py-2.5">
              <div className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-body">{s.merchant || sg.noDescription}</span>
                  <CategoryPill name={s.categoryName} className="hidden sm:inline-flex" />
                </div>
                <Money minor={s.amountMinor} currency={s.currency} abs className="text-body" />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-meta text-2">{dayLabel(s.occurredAt, locale)}</span>
                {people.map((p) => (
                  <ParticipantChip
                    key={p.id}
                    label={p.name}
                    disabled={busy === s.transactionId}
                    state={on.has(p.id) ? "on" : !tap && s.suggestedParticipantIds.includes(p.id) ? "suggested" : "off"}
                    title={s.reason === "merchant_rule" && s.suggestedParticipantIds.includes(p.id) ? sg.ruleTitle : undefined}
                    onToggle={() => void toggle(s, p.id)}
                  />
                ))}
                {names.length > 0 && tap?.myShareMinor != null ? (
                  <span className="text-meta text-2">
                    {fmt(sg.done, { names: names.join(t.common.listSep), amount: moneyText(tap.myShareMinor, s.currency) })}
                  </span>
                ) : (
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => dismiss(s.transactionId)}>
                    {sg.skip}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {rows.length > SHOW && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? t.common.collapse : plural(t.common.moreRows, rows.length - SHOW)}
        </Button>
      )}
    </Section>
  );
}
