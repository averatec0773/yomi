import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A calm placeholder block for server-rendered pages while they load (no spinners on the page body). */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden style={style} className={cn("animate-pulse rounded-md bg-tile motion-reduce:animate-none", className)} />;
}

/** Placeholder for a transaction list: day headers and 60px rows in the list card. */
export function ListSkeleton({ days = 3, rows = 4 }: { days?: number; rows?: number }) {
  return (
    <div className="-mx-gutter overflow-hidden border-y border-border bg-surface md:mx-0 md:rounded-xl md:border">
      {Array.from({ length: days }, (_, d) => (
        <div key={d}>
          <div className="flex h-9 items-center justify-between border-b border-line-soft bg-day px-4 md:px-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          {Array.from({ length: rows }, (_, r) => (
            <div key={r} className="flex h-row-phone items-center gap-3 border-b border-line-soft px-4 last:border-b-0 md:h-row md:gap-4 md:pr-3 md:pl-5">
              <Skeleton className="size-[42px] shrink-0 rounded-xl md:size-9 md:rounded-[10px]" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className={cn("h-3.5", r % 2 ? "w-28" : "w-40")} />
                <Skeleton className="h-3 w-48 max-w-full" />
              </div>
              <Skeleton className="hidden h-[26px] w-[124px] rounded-full md:block" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The page header while loading: the real title, placeholders for controls and actions. */
export function HeaderSkeleton({ title, controls = false, actions = 0 }: { title: ReactNode; controls?: boolean; actions?: number }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
      <h1 className="text-page font-semibold tracking-[-0.01em]">{title}</h1>
      {controls && <Skeleton className="h-9 w-56 rounded-lg" />}
      {actions > 0 && (
        <div className="flex w-full gap-2 md:ml-auto md:w-auto">
          {Array.from({ length: actions }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg md:w-36" />
          ))}
        </div>
      )}
    </div>
  );
}

/** A bordered card of placeholder rows (ListCard while loading). */
export function CardSkeleton({ rows = 3, header = true, className }: { rows?: number; header?: boolean; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-surface", className)}>
      {header && (
        <div className="flex h-12 items-center gap-2.5 border-b border-line-soft px-4 md:px-5">
          <Skeleton className="size-[18px] rounded-sm" />
          <Skeleton className="h-3.5 w-32" />
        </div>
      )}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 border-b border-line-soft px-4 last:border-b-0 md:px-5">
          <Skeleton className={cn("h-3.5", i % 2 ? "w-40" : "w-56")} />
          <Skeleton className="ml-auto h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}
