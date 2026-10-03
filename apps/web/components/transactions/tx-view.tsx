"use client";

import type {
  AcceptSuggestionsResult,
  ApplyAutoSplitResult,
  Balance,
  BulkToggleResult,
  BulkUpdateResult,
  DismissSuggestionResult,
  MerchantRule,
  MerchantSuggestResult,
  Participant as ParticipantDto,
  RevertSuggestionsResult,
  SetCategoryResult,
  SplitResult,
  TransactionItem,
} from "@yomi/contracts";
import type { ShortcutBindings } from "@yomi/contracts/shortcuts";
import { myShareMinor } from "@yomi/core/share";
import { CheckCheckIcon, ReceiptTextIcon, SearchXIcon, SplitIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ProvisionalNote } from "@/components/capture/provisional";
import { ReviewLine } from "@/components/capture/review-line";
import { CsvLink } from "@/components/csv-link";
import { Money } from "@/components/money";
import { awaitingNavKey } from "@/components/shell/shell-keys";
import { Button } from "@/components/ui-kit/button";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt, plural } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { useLocale, useT } from "@/i18n/client";
import type { Dictionary } from "@/i18n/en";
import { apiFetch } from "@/lib/api";
import { dateFormat, dayLabel, isMonth, utcDate } from "@/lib/month";
import { rangeLabel } from "@/lib/period";
import { isTypingTarget, keyFromEvent } from "@/lib/shortcut-keys";
import { useShortcuts } from "@/lib/shortcuts";
import { useIsDesktop } from "@/lib/use-media";
import { BulkBar } from "./bulk-bar";
import { categoriesFor } from "./category-menu";
import { PersonBalance, SpendStrip } from "./spend-strip";
import { buildSplits, canSplit, splitStateOf, toggledSplits, withSplits, withSplitView } from "./split-math";
import { TxDetails } from "./tx-details";
import { TxRow } from "./tx-row";
import { TxToolbar } from "./tx-toolbar";
import type { Category, CurrencyTotal, Panel, Participant, RowActions, Tx, TxFilters } from "./types";

interface Override {
  item: Tx;
  pending: number;
}

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

function byDateDesc(a: Tx, b: Tx): number {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? 1 : -1;
  return a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : b.id - a.id;
}

/** The row's display name for toasts. */
function rowName(t: Tx): string {
  return t.merchant || t.counterpartyRaw || t.description || `#${t.id}`;
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
  /** The list shows a date range (from /stats) rather than one month: copy says "this range" instead of "this month". */
  isRange?: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const keys = useShortcuts();
  // One media-query subscription for the whole list; rows get the answer as a prop.
  const desktop = useIsDesktop();
  const [, startTransition] = useTransition();
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

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);

  /**
   * Applies `optimistic` to the rows right away, runs `run`, then replaces them with what the server
   * returned (if anything) and refreshes. On failure the rows fall back to the server state.
   */
  const mutate = useCallback(
    async (ids: number[], optimistic: (t: Tx) => Tx, run: () => Promise<Map<number, Tx> | void>) => {
      const current = (id: number) => latest.current.view.find((t) => t.id === id);
      setOverrides((m) => {
        const next = new Map(m);
        for (const id of ids) {
          const base = next.get(id)?.item ?? current(id);
          if (!base) continue;
          next.set(id, { item: optimistic(base), pending: (next.get(id)?.pending ?? 0) + 1 });
        }
        return next;
      });
      let exact: Map<number, Tx> | void = undefined;
      let failed = false;
      try {
        exact = await run();
      } catch {
        failed = true;
      }
      setOverrides((m) => {
        const next = new Map(m);
        for (const id of ids) {
          const o = next.get(id);
          if (!o) continue;
          if (failed) next.delete(id);
          else next.set(id, { item: exact?.get(id) ?? o.item, pending: Math.max(o.pending - 1, 0) });
        }
        return next;
      });
      refresh();
    },
    [refresh],
  );

  const byId = (id: number) => latest.current.view.find((t) => t.id === id);

  /** "Also split the N existing ones": optimistic equal split of the merchant's unsplit rows on screen, then the server does all of them. */
  const applyExisting = useCallback(
    (rule: MerchantRule) => {
      const pids = rule.participants.map((p) => p.id);
      const ids = latest.current.view
        .filter((t) => t.merchant === rule.merchant && canSplit(t) && t.splits.length === 0 && t.accountId !== null)
        .map((t) => t.id);
      void mutate(
        ids,
        (x) => withSplits(x, buildSplits(x, { participantIds: pids, mode: "equal", payerId: selfId }, selfId, nameOf)),
        async () => {
          const res = await apiFetch<ApplyAutoSplitResult>("/merchant-rules/apply-auto-split", { json: { merchant: rule.merchant } });
          toast.success(plural(t.transactions.toastAppliedExisting, res.split, { merchant: rule.merchant }));
        },
      );
    },
    [mutate, selfId, nameOf, t],
  );
  const applyExistingRef = useRef(applyExisting);
  useEffect(() => {
    applyExistingRef.current = applyExisting;
  });

  const autoSplitToast = useCallback((rule: MerchantRule) => {
    if (!rule.autoSplit) {
      toast(fmt(t.transactions.toastAutoOff, { merchant: rule.merchant }));
      return;
    }
    const names = rule.participants.map((p) => p.name).join(t.common.listSep);
    toast.success(fmt(t.transactions.toastAutoOn, { merchant: rule.merchant, names }), {
      duration: rule.unsplitCount > 0 ? 12_000 : undefined,
      action:
        rule.unsplitCount > 0
          ? { label: plural(t.transactions.toastApplyExistingAction, rule.unsplitCount), onClick: () => applyExistingRef.current(rule) }
          : undefined,
    });
  }, [t]);

  /**
   * Split popover: one outcome toast when it closes (not one per tick), with Undo that puts back the split the row had
   * when the popover opened.
   */
  const splitSnapshot = useRef<{ id: number; tx: Tx } | null>(null);
  const splitOpened = useCallback((id: number) => {
    const tx = latest.current.view.find((x) => x.id === id);
    splitSnapshot.current = tx ? { id, tx } : null;
  }, []);
  const splitClosed = useCallback(
    (id: number) => {
      const snap = splitSnapshot.current;
      splitSnapshot.current = null;
      const now = latest.current.view.find((x) => x.id === id);
      if (!snap || snap.id !== id || !now) return;
      const key = (x: Tx) => JSON.stringify(x.splits.map((s) => [s.participantId, s.owedMinor, s.paidMinor]));
      if (key(snap.tx) === key(now)) return;
      const was = splitStateOf(snap.tx, selfId);
      const state = splitStateOf(now, selfId);
      const merchant = rowName(now);
      const message = state
        ? fmt(t.transactions.toastSplit, { merchant, names: state.participantIds.map(nameOf).join(t.common.listSep) })
        : fmt(t.transactions.toastUnsplit, { merchant });
      toast.success(message, {
        action: {
          label: t.common.undo,
          onClick: () => {
            const restore = was
              ? {
                  participantIds: was.participantIds.length ? was.participantIds : [was.payerId],
                  mode: was.mode,
                  ...(was.mode === "exact"
                    ? { exact: snap.tx.splits.filter((s) => !s.isSelf).map((s) => ({ participantId: s.participantId, owedMinor: s.owedMinor })) }
                    : {}),
                  ...(was.payerId !== selfId ? { payerId: was.payerId } : {}),
                }
              : { participantIds: [] as number[], mode: "equal" as const };
            void mutate(
              [id],
              (x) => withSplits(x, snap.tx.splits),
              async () => {
                await apiFetch<SplitResult>(`/transactions/${id}/split`, { json: restore });
                toast(t.transactions.toastUndone);
              },
            );
          },
        },
      });
    },
    [mutate, selfId, nameOf, t],
  );

  const actions: RowActions = useMemo(
    () => ({
      focus: (id) => setFocusId(id),
      select: (id, { shift }) => {
        const { view: rows, selected: sel } = latest.current;
        const next = new Set(sel);
        if (shift && anchor.current !== null) {
          const a = rows.findIndex((t) => t.id === anchor.current);
          const b = rows.findIndex((t) => t.id === id);
          if (a >= 0 && b >= 0) {
            const on = sel.has(anchor.current);
            for (const t of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) {
              if (on) next.add(t.id);
              else next.delete(t.id);
            }
          }
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        anchor.current = id;
        setSelected(next);
        setFocusId(id);
      },
      toggleChip: (id, pid) => {
        const row = byId(id);
        if (!row || !canSplit(row)) return;
        void mutate(
          [id],
          (x) => withSplits(x, toggledSplits(x, pid, selfId, nameOf)),
          async () => {
            const res = await apiFetch<SplitResult>(`/transactions/${id}/toggle-participant`, { json: { participantId: pid } });
            if (res.resetExact) toast(t.transactions.toastResetEqual);
            const base = byId(id);
            return base ? new Map([[id, withSplitView(base, res.split)]]) : undefined;
          },
        );
      },
      setSplit: (id, body) => {
        const exact = new Map((body.exact ?? []).map((e) => [e.participantId, e.owedMinor]));
        void mutate(
          [id],
          (x) => {
            const payerId = body.payerId ?? x.splits.find((s) => s.paidMinor !== 0)?.participantId ?? selfId;
            return withSplits(x, buildSplits(x, { ...body, exact, payerId }, selfId, nameOf));
          },
          async () => {
            const res = await apiFetch<SplitResult>(`/transactions/${id}/split`, { json: body });
            const base = byId(id);
            return base ? new Map([[id, withSplitView(base, res.split)]]) : undefined;
          },
        );
      },
      setAutoSplit: (id, enabled, participantIds, quiet) => {
        const merchant = byId(id)?.merchant;
        if (!merchant) return;
        void apiFetch<MerchantRule>("/merchant-rules/auto-split", { json: { merchant, participantIds, enabled } })
          .then((rule) => {
            if (!quiet) autoSplitToast(rule);
            refresh();
          })
          .catch(() => {});
      },
      addParticipant: async (name) => {
        try {
          const p = await apiFetch<ParticipantDto>("/participants", { json: { name } });
          setAdded((cur) => [...cur, p]);
          refresh();
          return p;
        } catch {
          return null;
        }
      },
      clearSplit: (id) => {
        void mutate(
          [id],
          (x) => withSplits(x, []),
          async () => {
            await apiFetch<SplitResult>(`/transactions/${id}/split`, { json: { participantIds: [], mode: "equal" } });
          },
        );
      },
      dismissSuggestion: (id) => {
        const tx = byId(id);
        if (!tx?.suggestion) return;
        const suggestion = tx.suggestion;
        const set = (on: boolean) =>
          mutate(
            [id],
            (x) => ({ ...x, suggestion: on ? null : suggestion, suggestedParticipantIds: on ? [] : suggestion.participantIds }),
            async () => {
              await apiFetch<DismissSuggestionResult>(`/transactions/${id}/split-suggestion/dismiss`, { json: { dismissed: on } });
            },
          );
        void set(true).then(() =>
          toast(fmt(t.transactions.toastDismissed, { merchant: rowName(tx) }), {
            action: { label: t.common.undo, onClick: () => void set(false) },
          }),
        );
      },
      muteMerchant: (id) => {
        const merchant = byId(id)?.merchant;
        if (!merchant) return;
        const before = new Map(latest.current.view.filter((x) => x.merchant === merchant && x.suggestion).map((x) => [x.id, x.suggestion!]));
        const ids = [...before.keys()];
        void mutate(
          ids,
          (x) => ({ ...x, suggestion: null, suggestedParticipantIds: [] }),
          async () => {
            const res = await apiFetch<MerchantSuggestResult>("/merchant-rules/suggest", { json: { merchant, suggest: false } });
            toast(fmt(t.transactions.toastMuted, { merchant }), {
              action: {
                label: t.common.undo,
                onClick: () =>
                  void mutate(
                    ids,
                    (x) => {
                      const s = before.get(x.id) ?? null;
                      return { ...x, suggestion: s, suggestedParticipantIds: s?.participantIds ?? [] };
                    },
                    async () => {
                      await apiFetch<MerchantSuggestResult>("/merchant-rules/suggest", {
                        json: { merchant, suggest: true, participantIds: res.previousParticipantIds },
                      });
                      toast(t.transactions.toastUndone);
                    },
                  ),
              },
            });
          },
        );
      },
      setCategory: (id, categoryId, applyToMerchant) => {
        const tx = byId(id);
        const cat = categories.find((c) => c.id === categoryId);
        if (!tx || !cat) return;
        const fits = (x: Tx) => categoriesFor(x.kind, [cat]).length > 0;
        const ids = applyToMerchant
          ? latest.current.view.filter((x) => x.id === id || (x.merchant === tx.merchant && !x.userEditedAt && x.kind !== "transfer" && fits(x))).map((x) => x.id)
          : [id];
        const before = { categoryId: tx.categoryId, categoryName: tx.categoryName };
        void mutate(
          ids,
          (x) => ({ ...x, categoryId, categoryName: cat.name, userEditedAt: x.id === id ? new Date().toISOString() : x.userEditedAt }),
          async () => {
            const res = await apiFetch<SetCategoryResult>(`/transactions/${id}/category`, { json: { categoryId, applyToMerchant } });
            if (applyToMerchant && res.affected > 1)
              toast.success(plural(t.transactions.toastCategoryMerchant, res.affected, { merchant: tx.merchant, category: categoryLabel(cat.name, t) }));
            else
              toast.success(fmt(t.transactions.toastCategory, { merchant: rowName(tx), category: categoryLabel(cat.name, t) }), {
                action: {
                  label: t.common.undo,
                  onClick: () =>
                    void mutate(
                      [id],
                      (x) => ({ ...x, ...before }),
                      async () => {
                        await apiFetch<TransactionItem>(`/transactions/${id}`, { method: "PATCH", json: { categoryId: before.categoryId } });
                        toast(t.transactions.toastUndone);
                      },
                    ),
                },
              });
          },
        );
      },
      setKind: (id, kind) => {
        void mutate(
          [id],
          (x) => {
            const next = { ...x, kind };
            return { ...next, myShareMinor: myShareMinor(next, x.splits) };
          },
          async () => new Map([[id, await apiFetch<TransactionItem>(`/transactions/${id}`, { method: "PATCH", json: { kind } })]]),
        );
      },
      setNote: (id, note) => {
        void mutate(
          [id],
          (x) => ({ ...x, note }),
          async () => new Map([[id, await apiFetch<TransactionItem>(`/transactions/${id}`, { method: "PATCH", json: { note } })]]),
        );
      },
      openPanel: (id, type) => {
        const prev = latest.current.panel;
        if (prev?.type === "split" && !(type === "split" && prev.id === id)) splitClosed(prev.id);
        if (type === "split") splitOpened(id);
        setPanel(type ? { id, type } : null);
        if (type) setFocusId(id);
      },
    }),
    // byId reads a ref; the rest are stable for the lifetime of the participant/category lists.
    [mutate, selfId, nameOf, categories, autoSplitToast, refresh, t, splitOpened, splitClosed],
  );

  // Bulk actions.
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  /** Bulk AA: exactly these people, equal, on every selected expense row (friend-paid rows are skipped by core). */
  const bulkApply = useCallback(
    (pids: number[]) => {
      const rows = latest.current.view.filter((t) => latest.current.selected.has(t.id) && canSplit(t));
      const mine = rows.filter((t) => (splitStateOf(t, selfId)?.payerId ?? selfId) === selfId);
      if (rows.length === 0) {
        toast(t.transactions.toastBulkNothing);
        return;
      }
      const drop = [...new Set(mine.flatMap((t) => splitStateOf(t, selfId)?.participantIds ?? []))].filter((id) => !pids.includes(id));
      void mutate(
        mine.map((t) => t.id),
        (x) => withSplits(x, buildSplits(x, { participantIds: pids, mode: "equal", payerId: selfId }, selfId, nameOf)),
        async () => {
          const skipped = new Set<number>();
          const ids = rows.map((t) => t.id);
          for (const pid of pids) {
            const res = await apiFetch<BulkToggleResult>("/split/bulk-toggle", { json: { transactionIds: ids, participantId: pid, on: true } });
            res.skipped.forEach((k) => skipped.add(k.transactionId));
          }
          for (const pid of drop) {
            const on = mine.filter((t) => splitStateOf(t, selfId)?.participantIds.includes(pid)).map((t) => t.id);
            if (!on.length) continue;
            await apiFetch<BulkToggleResult>("/split/bulk-toggle", { json: { transactionIds: on, participantId: pid, on: false } });
          }
          const names = pids.map(nameOf).join(t.common.listSep);
          toast.success(
            plural(t.transactions.toastBulkSplit, rows.length - skipped.size, { names }) +
              (skipped.size ? plural(t.transactions.toastBulkSplitSkipped, skipped.size) : ""),
          );
        },
      );
    },
    [mutate, selfId, nameOf, t],
  );

  /** "Accept N suggestions": equal split with each suggested row's people in one call; Undo clears those rows again. */
  const acceptAll = useCallback(() => {
    const rows = latest.current.view.filter((x) => x.suggestion && x.splits.length === 0 && canSplit(x));
    if (rows.length === 0) return;
    const pids = new Map(rows.map((x) => [x.id, x.suggestion!.participantIds]));
    void mutate(
      [...pids.keys()],
      (x) => withSplits(x, buildSplits(x, { participantIds: pids.get(x.id) ?? [], mode: "equal", payerId: selfId }, selfId, nameOf)),
      async () => {
        const res = await apiFetch<AcceptSuggestionsResult>("/split/accept-suggestions", { json: { transactionIds: [...pids.keys()] } });
        const accepted = res.accepted.map((a) => a.transactionId);
        const out = new Map<number, Tx>();
        for (const k of res.skipped) {
          const row = byId(k.transactionId);
          if (row) out.set(row.id, withSplits(row, []));
        }
        toast.success(
          plural(t.transactions.toastAccepted, accepted.length) +
            (res.skipped.length ? plural(t.transactions.toastAcceptedSkipped, res.skipped.length) : ""),
          {
            action: accepted.length
              ? {
                  label: t.common.undo,
                  onClick: () =>
                    void mutate(
                      accepted,
                      (x) => withSplits(x, []),
                      async () => {
                        await apiFetch<RevertSuggestionsResult>("/split/accept-suggestions/undo", { json: { transactionIds: accepted } });
                        toast(t.transactions.toastUndone);
                      },
                    ),
                }
              : undefined,
          },
        );
        return out;
      },
    );
  }, [mutate, selfId, nameOf, t]);

  const bulkUnsplit = useCallback(() => {
    const rows = latest.current.view.filter((t) => latest.current.selected.has(t.id) && t.splits.length > 0 && canSplit(t));
    if (rows.length === 0) return;
    const pids = [...new Set(rows.flatMap((t) => t.splits.filter((s) => !s.isSelf).map((s) => s.participantId)))];
    void mutate(
      rows.map((t) => t.id),
      (x) => (x.splits.some((s) => !s.isSelf && s.paidMinor !== 0) ? x : withSplits(x, [])),
      async () => {
        for (const pid of pids) {
          const ids = rows.filter((t) => t.splits.some((s) => s.participantId === pid)).map((t) => t.id);
          await apiFetch<BulkToggleResult>("/split/bulk-toggle", { json: { transactionIds: ids, participantId: pid, on: false } });
        }
        toast.success(plural(t.transactions.toastBulkUnsplit, rows.length));
      },
    );
  }, [mutate, t]);

  const bulkCategory = useCallback(
    (categoryId: number) => {
      const cat = categories.find((c) => c.id === categoryId);
      if (!cat) return;
      const ids = [...latest.current.selected];
      void mutate(
        latest.current.view.filter((t) => latest.current.selected.has(t.id) && categoriesFor(t.kind, [cat]).length > 0).map((t) => t.id),
        (x) => ({ ...x, categoryId, categoryName: cat.name }),
        async () => {
          const res = await apiFetch<BulkUpdateResult>("/transactions/bulk", { json: { ids, categoryId } });
          const skipped = ids.length - res.updated;
          toast.success(
            plural(t.transactions.toastBulkCategory, res.updated, { category: categoryLabel(cat.name, t) }) +
              (skipped ? plural(t.transactions.toastBulkCategorySkipped, skipped) : ""),
          );
        },
      );
    },
    [mutate, categories, t],
  );

  const bulkTransfer = useCallback(() => {
    const ids = [...latest.current.selected];
    void mutate(
      ids,
      (x) => {
        const next = { ...x, kind: "transfer" as const };
        return { ...next, myShareMinor: myShareMinor(next, x.splits) };
      },
      async () => {
        const res = await apiFetch<BulkUpdateResult>("/transactions/bulk", { json: { ids, kind: "transfer" } });
        toast.success(
          plural(t.transactions.toastBulkTransfer, res.updated) +
            (res.skippedSplit ? plural(t.transactions.toastBulkTransferSkipped, res.skippedSplit) : ""),
        );
      },
    );
  }, [mutate, t]);

  // Keyboard (keys from useShortcuts, defaults shown): j/k (or arrows) focus, x select (Shift+x a range), a/e split
  // popover (1-9 inside it), c category, n note, Esc clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector("[role=dialog],[role=menu]")) return;
      if (awaitingNavKey()) return;
      const { view: rows, focusId: fid, selected: sel } = latest.current;
      const idx = fid === null ? -1 : rows.findIndex((t) => t.id === fid);
      const focused = idx >= 0 ? rows[idx] : undefined;
      const move = (to: number) => {
        const t = rows[Math.max(0, Math.min(rows.length - 1, to))];
        if (!t) return;
        setFocusId(t.id);
        document.querySelector(`[data-tx-id="${t.id}"]`)?.scrollIntoView({ block: "nearest" });
      };
      if (e.key === "Escape") {
        if (sel.size) clearSelection();
        else setFocusId(null);
        return;
      }
      const arrows = !e.metaKey && !e.ctrlKey && !e.altKey;
      const key = keyFromEvent(e);
      const is = (bound: string) => bound !== "" && key === bound;
      if (is(keys.listNext) || (arrows && e.key === "ArrowDown")) {
        e.preventDefault();
        move(idx + 1);
      } else if (is(keys.listPrev) || (arrows && e.key === "ArrowUp")) {
        e.preventDefault();
        move(idx < 0 ? 0 : idx - 1);
      } else if (is(keys.listSelect) && focused) {
        e.preventDefault();
        actions.select(focused.id, { shift: e.shiftKey });
      } else if (is(keys.listCategory) && focused) {
        e.preventDefault();
        actions.openPanel(focused.id, "category");
      } else if ((is(keys.listSplit) || is(keys.listSplitAlt)) && focused && canSplit(focused)) {
        e.preventDefault();
        actions.openPanel(focused.id, "split");
      } else if (is(keys.listNote) && focused) {
        e.preventDefault();
        actions.openPanel(focused.id, "note");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, clearSelection, keys]);

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
        filters.unsplit && monthHasData ? (
          <EmptyState
            icon={SplitIcon}
            action={
              <Link href="/split" className="text-primary underline-offset-2 hover:underline">
                {t.transactions.backToSplit}
              </Link>
            }
          >
            {isRange ? t.transactions.allSplitRange : t.transactions.allSplitMonth}
          </EmptyState>
        ) : !monthHasData && !filtered ? (
          <EmptyState
            icon={ReceiptTextIcon}
            action={
              <Link href="/import" className="text-primary underline-offset-2 hover:underline">
                {t.transactions.goImport}
              </Link>
            }
          >
            {isRange ? t.transactions.emptyRange : t.transactions.emptyMonth}
          </EmptyState>
        ) : (
          <EmptyState icon={SearchXIcon}>{t.transactions.noMatch}</EmptyState>
        )
      ) : (
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
                  done={filters.unsplit && (t.splits.length > 0 || kept.has(t.id))}
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
