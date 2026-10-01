"use client";

import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui-kit/button";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "@/i18n/client";
import { openQuickAdd } from "@/lib/quick-add";
import { useUpdateParams } from "./use-params";

const SEARCH_DELAY_MS = 250;
const noop = () => () => {};

/**
 * Header search on Transactions (`/` focuses it): merchant, note, amount. Writes `?q=` after a short pause; Esc clears,
 * then blurs. Full width on phones.
 */
export function TxSearch({ q: initial }: { q: string }) {
  const t = useT();
  const tb = t.transactions.toolbar;
  const { update } = useUpdateParams();
  const [q, setQ] = useState(initial);
  const lastPushed = useRef(initial);

  // Back/forward or a cleared filter changes the URL: follow it unless the user is mid-typing.
  const [prev, setPrev] = useState(initial);
  if (prev !== initial) {
    setPrev(initial);
    if (initial !== lastPushed.current) {
      lastPushed.current = initial;
      setQ(initial);
    }
  }

  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  });

  useEffect(() => {
    const value = q.trim();
    if (value === lastPushed.current) return;
    const timer = setTimeout(() => {
      lastPushed.current = value;
      updateRef.current({ q: value });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <label className="flex h-10 w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 text-2 transition-colors duration-[120ms] focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/25 md:w-[280px]">
      <SearchIcon className="size-4 shrink-0" aria-hidden />
      <input
        type="search"
        data-page-search
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (q) {
              e.stopPropagation();
              setQ("");
            } else e.currentTarget.blur();
          }
        }}
        placeholder={tb.searchPlaceholder}
        aria-label={tb.searchLabel}
        className="h-full min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-3 [&::-webkit-search-cancel-button]:hidden"
      />
      {q ? (
        <button
          type="button"
          aria-label={tb.clearSearch}
          onClick={() => setQ("")}
          className="hit relative inline-flex size-6 items-center justify-center rounded-sm text-2 hover:text-foreground"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      ) : (
        <kbd aria-hidden className="hidden rounded-sm border border-border px-1.5 text-hint text-3 md:inline">
          /
        </kbd>
      )}
    </label>
  );
}

function useIsMac(): boolean {
  return useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => true,
  );
}

/** The page's one primary button: "Add ⌘K" (desktop; phones use the floating Add button). */
export function AddButton() {
  const t = useT();
  const mac = useIsMac();
  return (
    <Button variant="primary" onClick={() => openQuickAdd()} aria-label={t.nav.quickAdd} className="hidden md:inline-flex">
      <PlusIcon aria-hidden />
      {t.nav.quickAdd}
      <kbd className="font-sans text-hint font-normal opacity-80">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </Button>
  );
}
