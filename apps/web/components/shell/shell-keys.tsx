"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { openQuickAdd } from "@/lib/quick-add";
import { isTypingTarget, keyFromEvent } from "@/lib/shortcut-keys";
import { useShortcuts } from "@/lib/shortcuts";
import { NAV_KEYS, openShortcuts } from "./nav";

/** A leader press shorter than this is a tap: the sequence stays armed (and the hints shown) for WINDOW_MS after it. */
const TAP_MS = 400;
const WINDOW_MS = 1500;
/** Disarms even when the keyup never arrives (focus left the page mid-hold). */
const MAX_HOLD_MS = 10_000;

let armed = false;
let shown = false;
let pressedAt = 0;
let leaderCode = "";
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setShown(next: boolean) {
  if (shown === next) return;
  shown = next;
  for (const l of listeners) l();
}

function arm(code: string) {
  armed = true;
  pressedAt = Date.now();
  leaderCode = code;
  clearTimeout(timer);
  timer = setTimeout(disarm, MAX_HOLD_MS);
  setShown(true);
}

function disarm() {
  armed = false;
  leaderCode = "";
  clearTimeout(timer);
  setShown(false);
}

/** True while a leader sequence waits for its second key, so page keys (like "a" on /transactions) should ignore it. */
export function awaitingNavKey(): boolean {
  return armed;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True while the leader is held (or just tapped): navigation shows each item's second key. */
export function useLeaderHeld(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => false,
  );
}

/**
 * Global keys: ⌘K / Ctrl+K anywhere opens quick-add. Outside fields and dialogs, with the keys from `useShortcuts()`:
 * search focuses the page search ([data-page-search]) or opens quick-add; help opens the shortcuts sheet; the leader
 * (default "\") then a destination's key navigates. Holding the leader shows the keys in the sidebar; a tap keeps the
 * sequence armed for 1.5 s. Esc, any other key, a completed sequence or releasing a long hold ends it.
 * Page-level keys (j/k, x) belong to the pages; they skip typing targets, open dialogs and `awaitingNavKey()`.
 */
export function ShellKeys() {
  const router = useRouter();
  const keys = useShortcuts();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        disarm();
        openQuickAdd();
        return;
      }
      if (e.defaultPrevented || isTypingTarget(e.target) || document.querySelector("[role=dialog]")) {
        if (armed) disarm();
        return;
      }
      if (e.key === "Escape") {
        if (armed) disarm();
        return;
      }
      const key = keyFromEvent(e);
      if (armed) {
        // Shift on its own (for a shifted second key) keeps waiting; so does the leader's auto-repeat.
        if (key === null && ["Shift", "CapsLock"].includes(e.key)) return;
        if (e.repeat && key === keys.leader) {
          e.preventDefault();
          return;
        }
        const item = key === null ? undefined : NAV_KEYS.find((n) => keys[n.action] === key);
        disarm();
        if (item) {
          e.preventDefault();
          router.push(item.href);
          return;
        }
        if (key !== keys.leader) return;
      }
      if (key === null) return;
      if (key === keys.leader) {
        e.preventDefault();
        if (!e.repeat) arm(e.code);
        return;
      }
      if (key === keys.help) {
        e.preventDefault();
        openShortcuts();
        return;
      }
      if (key === keys.search) {
        e.preventDefault();
        // The page's search field (Transactions) when there is one, else quick-add.
        const search = document.querySelector<HTMLInputElement>("[data-page-search]");
        if (search && search.offsetParent !== null) search.focus();
        else openQuickAdd();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!armed || (leaderCode ? e.code !== leaderCode : keyFromEvent(e) !== keys.leader)) return;
      if (Date.now() - pressedAt < TAP_MS) {
        clearTimeout(timer);
        timer = setTimeout(disarm, WINDOW_MS);
      } else {
        disarm();
      }
    };
    const onBlur = () => disarm();
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [router, keys]);

  return null;
}
