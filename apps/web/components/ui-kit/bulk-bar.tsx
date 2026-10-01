"use client";

import { XIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { cn } from "@/lib/utils";

/** Class for the action buttons inside a BulkBar: 36px, 15px, icon first, 44px hit area on phones. */
export const bulkAction =
  "hit relative inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-body whitespace-nowrap text-foreground transition-colors duration-[120ms] outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-sunken [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-2";

/**
 * Floating selection bar. Desktop: one pill at the bottom center. Phones: a full-width card above the tab bar (never
 * under it), with the count and "Clear selection" on the first line and the actions below. While it is up,
 * `html[data-bulk]` is set so the tab bar's Add button steps aside (`bulk:` variant).
 */
export function BulkBar({
  label,
  count,
  clearLabel,
  onClear,
  children,
}: {
  /** Toolbar name ("Bulk actions"). */
  label: string;
  /** "3 selected", already formatted. */
  count: ReactNode;
  /** "Clear selection". */
  clearLabel: string;
  onClear: () => void;
  /** Action buttons (use `bulkAction`). */
  children: ReactNode;
}) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.bulk = "1";
    return () => {
      delete root.dataset.bulk;
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom)+8px)] z-50 flex justify-center px-2 md:bottom-5 md:px-gutter">
      <div
        role="toolbar"
        aria-label={label}
        className={cn(
          "pointer-events-auto flex w-full max-w-full flex-wrap items-center gap-1 rounded-2xl border border-border bg-raised p-1.5 shadow-dialog",
          "md:w-auto md:flex-nowrap md:rounded-full md:p-1",
        )}
      >
        <span className="order-1 flex-1 px-3 text-body whitespace-nowrap text-2 md:flex-none">{count}</span>
        <span className="order-3 flex w-full flex-wrap items-center gap-1 border-t border-line-soft pt-1.5 md:order-2 md:w-auto md:flex-nowrap md:border-0 md:pt-0">
          <span className="hidden h-4 w-px shrink-0 bg-border md:block" aria-hidden />
          {children}
          <span className="hidden h-4 w-px shrink-0 bg-border md:block" aria-hidden />
        </span>
        <button type="button" className={cn(bulkAction, "order-2 text-2 md:order-3")} onClick={onClear}>
          <XIcon aria-hidden />
          {clearLabel}
        </button>
      </div>
    </div>
  );
}
