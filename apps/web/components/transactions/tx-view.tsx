"use client";

// The transaction list: server rows under optimistic overrides, selection, focus and panels, and the page layout.

import type { Balance, Participant as ParticipantDto } from "@yomi/contracts";
import { CheckCheckIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProvisionalNote } from "@/components/capture/provisional";
import { ReviewLine } from "@/components/capture/review-line";
import { Button } from "@/components/ui-kit/button";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { dateFormat, isMonth, utcDate } from "@/lib/month";
import { rangeLabel } from "@/lib/period";
import { useIsDesktop } from "@/lib/use-media";
import { BulkBar } from "./bulk-bar";
import { PersonBalance, SpendStrip } from "./spend-strip";
import { canSplit } from "./split-math";
import { TxDayList } from "./tx-day-list";
import { TxDetails } from "./tx-details";
import { TxEmpty } from "./tx-empty";
import { TxToolbar } from "./tx-toolbar";
import type { Category, CurrencyTotal, Panel, Participant, Tx, TxFilters } from "./types";
import { useBulkActions } from "./use-bulk-actions";
import { useListKeys } from "./use-list-keys";
import { type Override, useTxActions } from "./use-tx-actions";

function byDateDesc(a: Tx, b: Tx): number {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? 1 : -1;
  return a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : b.id - a.id;
}

/** Keeps a prop's identity while its content is unchanged, so memoized rows skip re-rendering. */
function useStable<T>(value: T): T {
  const ref = useRef({ json: JSON.stringify(value), value });
  const json = JSON.stringify(value);
  if (json !== ref.current.json) ref.current = { json, value };
  return ref.current.value;
}

export function TxView({
  month,
  monthHasData,
  items,
  hiddenCount,
  totals,
  participants: participantsProp,
  categories: categoriesProp,
  filters,
  autoSplitMerchants: autoSplitProp,
  balances,
  today,
  reviewCount,
  isRange = false,
}: {
  /** 'YYYY-MM', or 'from~to' when the list shows a date range. */
  month: string;
  monthHasData: boolean;
  items: Tx[];
  hiddenCount: number;
  totals: CurrencyTotal[];
  participants: Participant[];
  categories: Category[];
  filters: TxFilters;
  /** Merchants whose rule splits new rows automatically. */
  autoSplitMerchants: string[];
  /** Balances with the person the list is filtered by (empty otherwise). */
  balances: Balance[];
  today: string;
  /** Items in the capture review queue (all periods). */
  reviewCount: number;
  /** The list shows a date range (from /analysis) rather than one month: copy says "this range" instead of "this month". */
  isRange?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  // One media-query subscription for the whole list; rows get the answer as a prop.
  const desktop = useIsDesktop();
  // People added from the AA popover show up before the server list catches up.
  const [added, setAdded] = useState<ParticipantDto[]>([]);
  const stableParticipants = useStable(participantsProp);
  const participants = useMemo(
    () => [...stableParticipants, ...added.filter((a) => !stableParticipants.some((p) => p.id === a.id))],
    [stableParticipants, added],
  );
  const categories = useStable(categoriesProp);
  const autoSplitList = useStable(autoSplitProp);
  const autoSplitSet = useMemo(() => new Set(autoSplitList), [autoSplitList]);
  const selfId = participants.find((p) => p.isSelf)?.id ?? 1;
  const others = useMemo(() => participants.filter((p) => !p.isSelf), [participants]);
  const nameOf = useCallback(
    (id: number) => {
      const p = participants.find((x) => x.id === id);
      return p ? (p.isSelf ? t.common.me : p.name) : `#${id}`;
    },
    [participants, t],
  );

  // Optimistic overrides on top of the server rows; settled ones drop when fresh props arrive.
  const [overrides, setOverrides] = useState<ReadonlyMap<number, Override>>(new Map());

  // Unsplit only: rows that get split drop out of the server list; keep them (dimmed, marked split) until the next
  // navigation so the list does not jump under the cursor. Keyed by month + filters.
  const navKey = JSON.stringify([month, filters]);
  const [kept, setKept] = useState<ReadonlyMap<number, Tx>>(new Map());
  const [keptNav, setKeptNav] = useState(navKey);
  const base = useMemo(() => (kept.size ? [...items, ...kept.values()].sort(byDateDesc) : items), [items, kept]);

  const view = useMemo(() => base.map((t) => overrides.get(t.id)?.item ?? t), [base, overrides]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [focusId, setFocusId] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const anchor = useRef<number | null>(null);

  // Fresh server rows: drop settled overrides, and selection/focus of rows that left the list.
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    const fresh = new Set(items.map((t) => t.id));
    const nextKept = new Map<number, Tx>();
    if (filters.unsplit && keptNav === navKey) {
      for (const t of [...kept.values(), ...prevItems]) {
        if (!fresh.has(t.id)) nextKept.set(t.id, overrides.get(t.id)?.item ?? t);
      }
    }
    if (nextKept.size || kept.size) setKept(nextKept);
    if (keptNav !== navKey) setKeptNav(navKey);
    if (overrides.size) setOverrides(new Map([...overrides].filter(([, o]) => o.pending > 0)));
    const ids = new Set([...fresh, ...nextKept.keys()]);
    if ([...selected].some((id) => !ids.has(id))) setSelected(new Set([...selected].filter((id) => ids.has(id))));
    if (focusId !== null && !ids.has(focusId)) setFocusId(null);
  }

  const latest = useRef({ view, items, selected, focusId, panel, others });
  useEffect(() => {
    latest.current = { view, items, selected, focusId, panel, others };
  });

  const { actions, mutate } = useTxActions({ latest, setOverrides, setSelected, setFocusId, setPanel, setAdded, anchor, selfId, nameOf, categories });
  const { clearSelection, bulkApply, acceptAll, bulkUnsplit, bulkCategory, bulkTransfer } = useBulkActions({
    latest,
    mutate,
    setSelected,
    anchor,
    selfId,
    nameOf,
    categories,
  });
  useListKeys({ latest, actions, clearSelection, setFocusId });

  // Header totals: server totals plus the optimistic delta of rows not yet refreshed.
  const shownTotals = useMemo(() => {
    const map = new Map(totals.map((t) => [t.currency, t.spendingMinor]));
    const server = new Map(base.map((t) => [t.id, t]));
    for (const [id, o] of overrides) {
      const s = server.get(id);
      if (!s) continue;
      map.set(s.currency, (map.get(s.currency) ?? 0) + o.item.myShareMinor - s.myShareMinor);
    }
    return [...map].map(([currency, spendingMinor]) => ({ currency, spendingMinor }));
  }, [totals, base, overrides]);

  const details = panel?.type === "details" ? (view.find((t) => t.id === panel.id) ?? null) : null;
  const periodLabel = isRange
    ? rangeLabel(month.split("~")[0]!, month.split("~")[1]!, locale)
    : isMonth(month)
      ? dateFormat(locale, { month: "long" }).format(utcDate(month))
      : month;
  const counts = new Map(totals.map((x) => [x.currency, x.count]));
  const notSplit = others.length ? view.filter((x) => canSplit(x) && x.splits.length === 0 && x.accountId !== null).length : 0;
  const suggestedCount = view.filter((x) => x.suggestion && x.splits.length === 0 && canSplit(x)).length;
  const filtered = Boolean(filters.q || filters.categoryId || filters.participantId || filters.uncategorized || filters.unsplit);
  const csvHref = isRange
    ? `/api/export/transactions.csv?${new URLSearchParams({ from: month.split("~")[0]!, to: month.split("~")[1]! }).toString()}`
    : `/api/export/transactions.csv?month=${month}`;

  return (
    <div className="flex flex-col gap-5">
      <ReviewLine count={reviewCount} />
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <SpendStrip
            totals={shownTotals.map((x) => ({ ...x, count: counts.get(x.currency) ?? 0 }))}
            label={fmt(t.transactions.yourShare, { period: periodLabel })}
            note={filtered ? t.transactions.wholePeriodNote : undefined}
          />
          {totals.map((x) => (
            <ProvisionalNote key={x.currency} totals={x} currency={x.currency} />
          ))}
        </div>
        {filters.participantId !== undefined && <PersonBalance balances={balances} today={today} />}
        {suggestedCount > 0 && (
          <Button onClick={acceptAll} title={t.transactions.acceptAllTitle}>
            <CheckCheckIcon aria-hidden />
            {plural(t.transactions.acceptAll, suggestedCount)}
          </Button>
        )}
      </div>

      <TxToolbar
        filters={filters}
        categories={categories}
        participants={participants}
        count={view.length}
        notSplit={notSplit}
        hiddenCount={hiddenCount}
      />

      {filters.unsplit && view.length > 0 && (
        <p className="rounded-md bg-sunken px-3 py-1.5 text-meta text-2">
          {fmt(t.transactions.unsplitHint, { name: others[0]?.name ?? t.transactions.defaultFriend })}
        </p>
      )}

      {view.length === 0 ? (
        <TxEmpty unsplit={filters.unsplit} monthHasData={monthHasData} filtered={filtered} isRange={isRange} />
      ) : (
        <TxDayList
          view={view}
          month={month}
          today={today}
          csvHref={csvHref}
          others={others}
          selfId={selfId}
          nameOf={nameOf}
          categories={categories}
          selected={selected}
          focusId={focusId}
          panel={panel}
          actions={actions}
          unsplit={filters.unsplit}
          kept={kept}
          autoSplitSet={autoSplitSet}
          desktop={desktop}
        />
      )}

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          rows={view.filter((t) => selected.has(t.id))}
          others={others}
          selfId={selfId}
          categories={categories}
          onApply={bulkApply}
          onUnsplit={bulkUnsplit}
          onAdd={actions.addParticipant}
          onCategory={bulkCategory}
          onTransfer={bulkTransfer}
          onClear={clearSelection}
        />
      )}

      <TxDetails tx={details} onClose={() => setPanel(null)} />
    </div>
  );
}
