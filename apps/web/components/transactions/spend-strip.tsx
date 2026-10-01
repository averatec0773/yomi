"use client";

import type { Balance } from "@yomi/contracts";
import { Fragment, useState } from "react";
import { Money } from "@/components/money";
import { SettleAllSheet } from "@/components/split/settle-all-sheet";
import { Dialog } from "@/components/ui/dialog";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

export interface SpendTotal {
  currency: string;
  spendingMinor: number;
  count: number;
}

/**
 * The number on Transactions: my share of spending in the period. The currency with the most rows is the hero (32px);
 * the others follow in one quiet line, never summed. Unboxed at every width (StatCard is for /stats, /split, /assets).
 * With filters on, the number stays the whole period's and is dimmed with `note`. Nothing when the period has no rows.
 */
export function SpendStrip({ totals, label, note }: { totals: SpendTotal[]; label: string; note?: string }) {
  const sorted = [...totals].sort((a, b) => b.count - a.count || b.spendingMinor - a.spendingMinor);
  const hero = sorted[0];
  if (!hero) return null;
  const rest = sorted.slice(1);
  return (
    <section aria-label={label} className="flex flex-col gap-1 md:flex-row md:flex-wrap md:items-baseline md:gap-x-3.5">
      <span className="text-meta text-2 md:order-last">
        {label}
        {note && <span data-testid="spend-note"> · {note}</span>}
      </span>
      <span className={cn("flex flex-wrap items-baseline gap-x-3.5 gap-y-1", note && "opacity-60")}>
        <Money minor={hero.spendingMinor} currency={hero.currency} className="justify-start text-display font-semibold tracking-[-0.02em]" />
        {rest.length > 0 && (
          <span className="num text-left text-body text-2">
            {rest.map((r, i) => (
              <Fragment key={r.currency}>
                {i > 0 && " · "}
                <Money minor={r.spendingMinor} currency={r.currency} tone="muted" />
              </Fragment>
            ))}
          </span>
        )}
      </span>
    </section>
  );
}

/**
 * Only when the list is filtered by one person: that person's neutral line per open currency, "To settle with Alex
 * $719.73" (plain) or "You pay Li $40.00" (clay), each with a Settle link to the settle dialog.
 */
export function PersonBalance({ balances, today }: { balances: Balance[]; today: string }) {
  const t = useT();
  const tb = t.aa.balances;
  const [settle, setSettle] = useState<Balance | null>(null);
  const open = balances.filter((b) => b.owedToMeMinor !== 0);
  if (open.length === 0) return null;
  return (
    <div role="group" aria-label={tb.label} className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      {open.map((b) => {
        const toMe = b.owedToMeMinor > 0;
        return (
          <span key={b.currency} className="inline-flex items-baseline gap-2 text-body">
            <span className="text-2">{fmt(toMe ? tb.toSettle : tb.youPay, { name: b.name })}</span>
            <Money minor={b.owedToMeMinor} currency={b.currency} abs tone={toMe ? "default" : "neg"} className="font-semibold" />
            <button
              type="button"
              onClick={() => setSettle(b)}
              aria-label={fmt(tb.settleAria, { name: b.name, currency: b.currency })}
              className="hit relative rounded-sm text-meta text-primary underline-offset-2 hover:underline"
            >
              {tb.settle}
            </button>
          </span>
        );
      })}
      <Dialog open={settle !== null} onOpenChange={(o) => !o && setSettle(null)}>
        {settle && (
          <SettleAllSheet participantId={settle.participantId} name={settle.name} balance={settle} today={today} onDone={() => setSettle(null)} />
        )}
      </Dialog>
    </div>
  );
}
