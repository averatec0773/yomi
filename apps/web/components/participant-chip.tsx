"use client";

import type { ComponentProps, ReactNode } from "react";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

export type ParticipantChipState = "off" | "on" | "suggested" | "payer";

export interface ParticipantChipProps extends Omit<ComponentProps<"button">, "children" | "onToggle"> {
  /** Display name, or a node such as "+" for the ghost add chip. */
  label: ReactNode;
  /**
   * off: not in the split (ghost outline).
   * on: shares this row (teal soft fill).
   * suggested: a rule suggests them; dashed teal outline, one tap accepts.
   * payer: they paid (solid teal), shown with a small "paid" mark.
   */
  state?: ParticipantChipState;
  size?: "sm" | "md";
  /** Called with the state the chip should move to (off/suggested → on, on → off). */
  onToggle?: (next: boolean) => void;
}

const STATE: Record<ParticipantChipState, string> = {
  off: "border-border text-2 hover:border-foreground/25 hover:text-foreground",
  on: "border-transparent bg-primary-soft text-primary",
  suggested: "border-dashed border-primary/60 text-2 hover:text-primary",
  payer: "border-transparent bg-primary text-primary-foreground",
};

/** Toggleable participant chip for split tagging. Keep it cheap: parents own the optimistic state. */
export function ParticipantChip({
  label,
  state = "off",
  size = "sm",
  onToggle,
  className,
  onClick,
  ...props
}: ParticipantChipProps) {
  const t = useT();
  const active = state === "on" || state === "payer";
  return (
    <button
      type="button"
      aria-pressed={active}
      data-state={state}
      className={cn(
        "hit relative inline-flex shrink-0 items-center gap-1 rounded-full border whitespace-nowrap transition-colors duration-[120ms] ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-5 px-2 text-meta" : "h-7 px-3 text-body",
        STATE[state],
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onToggle?.(!active);
      }}
      {...props}
    >
      {label}
      {state === "payer" && <span className="text-[0.85em] opacity-80">{t.aa.paidMark}</span>}
    </button>
  );
}
