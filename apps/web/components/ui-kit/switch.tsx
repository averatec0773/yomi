"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * An on/off setting: label (15px) and an optional help line (13px) on the left, the switch on the right. The whole
 * row toggles; role switch with aria-checked, 44px hit area on phones.
 */
export function Switch({
  checked,
  onChange,
  label,
  help,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "group flex w-full items-center gap-3 rounded-md py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body">{label}</span>
        {help && <span className="text-meta text-2">{help}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[120ms]",
          checked ? "bg-primary" : "bg-line-strong",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 size-4 rounded-full bg-surface shadow-sm transition-transform duration-[120ms]",
            checked && "translate-x-4",
          )}
        />
      </span>
    </button>
  );
}
