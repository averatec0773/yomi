"use client";

// Actions of the selection bar (split, unsplit, category, transfer) and "Accept N suggestions".

import type { AcceptSuggestionsResult, BulkToggleResult, BulkUpdateResult, RevertSuggestionsResult } from "@yomi/contracts";
import { myShareMinor } from "@yomi/core/share";
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import { toast } from "sonner";
import { plural } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { categoriesFor } from "./category-menu";
import { buildSplits, canSplit, splitStateOf, withSplits } from "./split-math";
import type { Category, Tx } from "./types";
import type { Mutate, TxLatest } from "./use-tx-actions";

export function useBulkActions({
  latest,
  mutate,
  setSelected,
  anchor,
  selfId,
  nameOf,
  categories,
}: {
  latest: RefObject<TxLatest>;
  mutate: Mutate;
  setSelected: Dispatch<SetStateAction<ReadonlySet<number>>>;
  anchor: RefObject<number | null>;
  selfId: number;
  nameOf: (id: number) => string;
  categories: Category[];
}) {
  const t = useT();
  const byId = useCallback((id: number) => latest.current.view.find((t) => t.id === id), [latest]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [setSelected, anchor]);

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
    [latest, mutate, selfId, nameOf, t],
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
  }, [latest, byId, mutate, selfId, nameOf, t]);

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
  }, [latest, mutate, t]);

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
    [latest, mutate, categories, t],
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
  }, [latest, mutate, t]);

  return { clearSelection, bulkApply, acceptAll, bulkUnsplit, bulkCategory, bulkTransfer };
}
