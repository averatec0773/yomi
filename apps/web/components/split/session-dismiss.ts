"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const cache = new Map<string, string>();

function read(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "[]";
  } catch {
    return cache.get(key) ?? "[]";
  }
}

/** Ids hidden for this browser session ("Ignore" / "Skip"); nothing is written to the ledger. */
export function useSessionDismissed(key: string): [Set<number>, (id: number) => void] {
  const raw = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(key),
    () => "[]",
  );
  const set = new Set<number>(JSON.parse(raw) as number[]);
  const dismiss = useCallback(
    (id: number) => {
      const next = JSON.stringify([...new Set([...(JSON.parse(read(key)) as number[]), id])]);
      try {
        sessionStorage.setItem(key, next);
      } catch {
        cache.set(key, next);
      }
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [set, dismiss];
}
