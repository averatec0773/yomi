"use client";

import type { Theme } from "@yomi/contracts";
import { createContext, type ReactNode, use, useMemo, useState } from "react";

interface ThemeValue {
  theme: Theme;
  /** Applies a theme at once (Settings > Appearance): sets or clears html[data-theme] without a reload. */
  setTheme: (next: Theme) => void;
}

const ThemeContext = createContext<ThemeValue>({ theme: "system", setTheme: () => {} });

/** Sets html[data-theme]; `system` removes it, so CSS follows prefers-color-scheme (the root layout does the same). */
function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/**
 * Mounted once in the root layout with the stored theme. The layout already renders html[data-theme] on the server
 * (no flash); this only keeps the client in step when the user changes it.
 */
export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  const [local, setLocal] = useState<{ from: Theme; value: Theme }>({ from: theme, value: theme });
  // A new server value (another device, a refresh) replaces what was applied locally.
  const current = local.from === theme ? local.value : theme;
  if (local.from !== theme) setLocal({ from: theme, value: theme });

  const value = useMemo<ThemeValue>(
    () => ({
      theme: current,
      setTheme: (next) => {
        applyTheme(next);
        setLocal({ from: theme, value: next });
      },
    }),
    [current, theme],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeValue {
  return use(ThemeContext);
}
