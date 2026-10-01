"use client";

import { mergeShortcuts, type ShortcutBindings, type ShortcutOverrides } from "@yomi/contracts/shortcuts";
import { createContext, type ReactNode, use, useMemo, useState } from "react";

interface ShortcutsValue {
  bindings: ShortcutBindings;
  overrides: ShortcutOverrides;
  /** Applies saved overrides at once (Settings), before the server re-renders. */
  setOverrides: (next: ShortcutOverrides) => void;
}

const ShortcutsContext = createContext<ShortcutsValue>({
  bindings: mergeShortcuts({}),
  overrides: {},
  setOverrides: () => {},
});

/**
 * Mounted once in the root layout with the user's stored overrides (server-rendered, so there is no flash of the
 * defaults). Every key handler and hint reads its keys through `useShortcuts()`.
 */
export function ShortcutsProvider({ overrides, children }: { overrides: ShortcutOverrides; children: ReactNode }) {
  const serverKey = JSON.stringify(overrides);
  const [local, setLocal] = useState<{ from: string; value: ShortcutOverrides }>({ from: serverKey, value: overrides });
  // A new server value (another device, a refresh) replaces what was applied locally.
  const current = local.from === serverKey ? local.value : overrides;
  if (local.from !== serverKey) setLocal({ from: serverKey, value: overrides });

  const value = useMemo<ShortcutsValue>(
    () => ({
      bindings: mergeShortcuts(current),
      overrides: current,
      setOverrides: (next) => setLocal({ from: serverKey, value: next }),
    }),
    [current, serverKey],
  );
  return <ShortcutsContext value={value}>{children}</ShortcutsContext>;
}

/** The current key per action (defaults plus the user's overrides); "" means the action has no key. */
export function useShortcuts(): ShortcutBindings {
  return use(ShortcutsContext).bindings;
}

/** Overrides and their setter, for Settings. */
export function useShortcutOverrides(): Pick<ShortcutsValue, "overrides" | "setOverrides"> {
  const { overrides, setOverrides } = use(ShortcutsContext);
  return { overrides, setOverrides };
}
