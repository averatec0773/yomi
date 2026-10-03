"use client";

// Row actions of the transaction list: optimistic overrides (mutate), the per-row callbacks and their toasts.

import type {
  ApplyAutoSplitResult,
  DismissSuggestionResult,
  MerchantRule,
  MerchantSuggestResult,
  Participant as ParticipantDto,
  SetCategoryResult,
  SplitResult,
  TransactionItem,
} from "@yomi/contracts";
import { myShareMinor } from "@yomi/core/share";
import { useRouter } from "next/navigation";
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useMemo, useRef, useTransition } from "react";
import { toast } from "sonner";
import { fmt, plural } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { categoriesFor } from "./category-menu";
import { buildSplits, canSplit, splitStateOf, toggledSplits, withSplits, withSplitView } from "./split-math";
import type { Category, Panel, RowActions, Tx } from "./types";

export interface Override {
  item: Tx;
  pending: number;
}

/** What the callbacks read when they run; TxView refreshes it after every render. */
export interface TxLatest {
  view: Tx[];
  selected: ReadonlySet<number>;
  focusId: number | null;
  panel: Panel | null;
}

export type Mutate = (ids: number[], optimistic: (t: Tx) => Tx, run: () => Promise<Map<number, Tx> | void>) => Promise<void>;

/** The row's display name for toasts. */
function rowName(t: Tx): string {
  return t.merchant || t.counterpartyRaw || t.description || `#${t.id}`;
}

export function useTxActions({
  latest,
  setOverrides,
  setSelected,
  setFocusId,
  setPanel,
  setAdded,
  anchor,
  selfId,
  nameOf,
  categories,
}: {
  latest: RefObject<TxLatest>;
  setOverrides: Dispatch<SetStateAction<ReadonlyMap<number, Override>>>;
  setSelected: Dispatch<SetStateAction<ReadonlySet<number>>>;
  setFocusId: Dispatch<SetStateAction<number | null>>;
  setPanel: Dispatch<SetStateAction<Panel | null>>;
  setAdded: Dispatch<SetStateAction<ParticipantDto[]>>;
  anchor: RefObject<number | null>;
  selfId: number;
  nameOf: (id: number) => string;
  categories: Category[];
}): { actions: RowActions; mutate: Mutate } {
  const router = useRouter();
  const t = useT();
  const [, startTransition] = useTransition();

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

  return { actions, mutate };
}
