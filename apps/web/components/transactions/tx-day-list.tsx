"use client";

// The transaction rows grouped by day (sticky day headers with the day's spending), the keys hint and the CSV link.

import type { ShortcutBindings } from "@yomi/contracts/shortcuts";
import { useMemo } from "react";
import { CsvLink } from "@/components/csv-link";
import { Money } from "@/components/money";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import type { Dictionary } from "@/i18n/en";
import { dayLabel } from "@/lib/month";
import { useShortcuts } from "@/lib/shortcuts";
import { TxRow } from "./tx-row";
import type { Category, Panel, Participant, RowActions, Tx } from "./types";

/** The line under the list with the user's current keys; parts whose key is unset drop out. */
function keysHint(parts: Dictionary["transactions"]["keysHint"], k: ShortcutBindings): string {
  const join = (...keys: string[]) => keys.filter(Boolean).join(" / ");
  return [
    [parts.move, join(k.listNext, k.listPrev)],
    [parts.select, k.listSelect],
    [parts.split, join(k.listSplit, k.listSplitAlt)],
    [parts.category, k.listCategory],
    [parts.note, k.listNote],
    [parts.clear, "Esc"],
    [parts.all, k.help],
  ]
    .filter(([, keys]) => keys)
    .map(([part, keys]) => fmt(part!, { keys: keys! }))
    .join(" · ");
}

export function TxDayList({
  view,
  month,
  today,
  csvHref,
  others,
  selfId,
  nameOf,
  categories,
  selected,
  focusId,
  panel,
  actions,
  unsplit,
  kept,
  autoSplitSet,
  desktop,
}: {
  view: Tx[];
  month: string;
  today: string;
  csvHref: string;
  others: Participant[];
  selfId: number;
  nameOf: (id: number) => string;
  categories: Category[];
  selected: ReadonlySet<number>;
  focusId: number | null;
  panel: Panel | null;
  actions: RowActions;
  unsplit: boolean;
  kept: ReadonlyMap<number, Tx>;
  autoSplitSet: ReadonlySet<string>;
  desktop: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const keys = useShortcuts();

  const groups = useMemo(() => {
    const out: { date: string; rows: Tx[]; sums: Map<string, number> }[] = [];
    for (const t of view) {
      const date = t.occurredOn;
      let g = out.at(-1);
      if (!g || g.date !== date) {
        g = { date, rows: [], sums: new Map() };
        out.push(g);
      }
      g.rows.push(t);
      if (t.myShareMinor !== 0) g.sums.set(t.currency, (g.sums.get(t.currency) ?? 0) + t.myShareMinor);
    }
    return out;
  }, [view]);

  return (
    <div>
      <ListCard bleed role="grid" aria-label={fmt(t.transactions.gridLabel, { month })} aria-multiselectable bodyClassName="divide-y-0">
        {groups.map((g) => (
          <div key={g.date} role="rowgroup">
            <div className="sticky top-0 z-10 flex h-9 items-center justify-between border-b border-line-soft bg-day px-4 text-meta text-2 md:px-5">
              <span className="font-medium whitespace-nowrap">{dayLabel(g.date, locale, { weekday: true, relative: true, today })}</span>
              {g.sums.size > 0 && (
                <span className="inline-flex items-baseline gap-1">
                  {t.transactions.daySpent}
                  {[...g.sums].map(([cur, v], i) => (
                    <span key={cur} className="inline-flex items-baseline gap-1">
                      {i > 0 && <span aria-hidden>·</span>}
                      <Money minor={v} currency={cur} />
                    </span>
                  ))}
                </span>
              )}
            </div>
            {g.rows.map((t) => (
              <TxRow
                key={t.id}
                tx={t}
                others={others}
                selfId={selfId}
                nameOf={nameOf}
                categories={categories}
                selected={selected.has(t.id)}
                focused={focusId === t.id}
                selecting={selected.size > 0}
                panel={panel?.id === t.id ? panel.type : null}
                actions={actions}
                done={unsplit && (t.splits.length > 0 || kept.has(t.id))}
                autoSplit={autoSplitSet.has(t.merchant)}
                desktop={desktop}
              />
            ))}
          </div>
        ))}
      </ListCard>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-3">
        <p className="hidden text-hint text-3 md:block">{keysHint(t.transactions.keysHint, keys)}</p>
        <CsvLink href={csvHref} />
      </div>
    </div>
  );
}
