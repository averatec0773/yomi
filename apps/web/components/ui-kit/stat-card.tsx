import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface StatCardProps {
  /** Small label above the number, e.g. "USD spending" or "To settle with Alex". */
  label: ReactNode;
  /** The number, usually a <Money/>. Rendered at 36px (`text-hero`), or 22px with `size="total"`. */
  value: ReactNode;
  /** Quiet lines under the number (secondary currencies, comparisons), one fact per line. */
  meta?: ReactNode;
  size?: "hero" | "total";
  /** Extra blocks under the meta (targets, actions). */
  children?: ReactNode;
  /** Region name (the section gets role region through aria-label). */
  "aria-label"?: string;
  className?: string;
}

/**
 * One card for hero numbers on /analysis, /split and /assets: surface, hairline, 12px radius, 20px padding. Transactions
 * keeps its unboxed spend strip.
 */
export function StatCard({ label, value, meta, size = "hero", children, className, ...rest }: StatCardProps) {
  return (
    <section aria-label={rest["aria-label"]} className={cn("flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface p-5", className)}>
      <div className="text-meta text-2">{label}</div>
      <div className={cn(size === "hero" ? "text-hero font-semibold tracking-[-0.02em]" : "text-total font-medium")}>{value}</div>
      {meta && <div className="flex flex-col gap-0.5 text-meta text-2">{meta}</div>}
      {children}
    </section>
  );
}
