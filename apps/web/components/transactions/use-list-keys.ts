"use client";

// Keyboard control of the transaction list (focus, select, open the split, category and note panels).

import { type Dispatch, type RefObject, type SetStateAction, useEffect } from "react";
import { awaitingNavKey } from "@/components/shell/shell-keys";
import { isTypingTarget, keyFromEvent } from "@/lib/shortcut-keys";
import { useShortcuts } from "@/lib/shortcuts";
import { canSplit } from "./split-math";
import type { RowActions } from "./types";
import type { TxLatest } from "./use-tx-actions";

export function useListKeys({
  latest,
  actions,
  clearSelection,
  setFocusId,
}: {
  latest: RefObject<TxLatest>;
  actions: RowActions;
  clearSelection: () => void;
  setFocusId: Dispatch<SetStateAction<number | null>>;
}) {
  const keys = useShortcuts();

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
  }, [actions, clearSelection, keys, latest, setFocusId]);
}
