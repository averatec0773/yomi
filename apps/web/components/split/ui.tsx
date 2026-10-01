"use client";

import { minorDigits, parseAmountToMinor } from "@yomi/core/money";
import { useRouter } from "next/navigation";
import { type ComponentProps, type ReactNode, useState, useTransition } from "react";
import { DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { type DialogSize, dialogSize } from "@/components/ui-kit/dialog-size";
import { cn } from "@/lib/utils";

export const CURRENCIES = ["CNY", "USD"] as const;

/** Currency choices: the ones in play first, then CNY/USD. */
export function currencyOptions(inPlay: readonly string[] = []): string[] {
  return [...new Set([...inPlay, ...CURRENCIES])];
}

/** "12.5" → 1250 in the currency's minor units; null when empty or invalid. */
export function toMinor(input: string, currency: string): number | null {
  if (!input.trim()) return null;
  try {
    return parseAmountToMinor(input, minorDigits(currency));
  } catch {
    return null;
  }
}

/** 1250 → "12.50" for prefilling an input. */
export function toInput(minor: number, currency: string): string {
  const d = minorDigits(currency);
  const abs = Math.abs(minor);
  return d === 0 ? String(abs) : (abs / 10 ** d).toFixed(d);
}

/** Units of `origCur` per 1 `cur`, from two minor amounts (display only). */
export function rateOf(minor: number, cur: string, origMinor: number, origCur: string): number | null {
  if (!minor || !origMinor) return null;
  const a = Math.abs(minor) / 10 ** minorDigits(cur);
  const b = Math.abs(origMinor) / 10 ** minorDigits(origCur);
  return b / a;
}

/** Runs a mutation with a pending flag, then refreshes the server components. */
export function useMutation() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refreshing, startTransition] = useTransition();
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    try {
      const out = await fn();
      startTransition(() => router.refresh());
      return out;
    } catch {
      return undefined; // apiFetch already toasted
    } finally {
      setBusy(false);
    }
  }
  const refresh = () => startTransition(() => router.refresh());
  return { run, busy, pending: busy || refreshing, refresh };
}

/**
 * A titled block on Split and settle. `card`: the page's card look (surface, 14px radius) with an icon, the title and a
 * quiet note on the right (`aside`, e.g. "25 new"); the description becomes the title's tooltip. Without `card` it is a
 * plain section with a top margin and the description under the title.
 */
export function Section({
  title,
  count,
  description,
  action,
  children,
  className,
  icon,
  iconClassName,
  aside,
  card = false,
}: {
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** A lucide icon element, e.g. <HistoryIcon /> (an element, so server components can pass it). */
  icon?: ReactNode;
  iconClassName?: string;
  aside?: ReactNode;
  card?: boolean;
}) {
  if (card) {
    return (
      <section className={cn("flex flex-col rounded-xl border border-border bg-surface p-5", className)}>
        <div className="mb-2 flex items-center gap-2.5">
          {icon && <span aria-hidden className={cn("inline-flex shrink-0 text-2 [&>svg]:size-[18px] [&>svg]:stroke-[1.8]", iconClassName)}>{icon}</span>}
          <h2 className="min-w-0 flex-1 truncate text-title font-semibold" title={typeof description === "string" ? description : undefined}>
            {title}
            {count !== undefined && aside === undefined && <span className="ml-1.5 text-meta font-normal text-2">{count}</span>}
          </h2>
          {aside !== undefined && <span className="shrink-0 text-meta text-2">{aside}</span>}
          {action}
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className={cn("mt-10", className)}>
      <div className="mb-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-title font-semibold">
            {icon && <span aria-hidden className={cn("inline-flex shrink-0 text-2 [&>svg]:size-[18px] [&>svg]:stroke-[1.8]", iconClassName)}>{icon}</span>}
            {title}
            {count !== undefined && <span className="text-meta font-normal text-2">{count}</span>}
          </h2>
          {description && <p className="mt-0.5 text-meta text-2">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-meta text-2">{label}</span>
      {children}
      {hint && <span className="text-meta text-2">{hint}</span>}
    </label>
  );
}

const control =
  "h-9 w-full min-w-0 rounded-lg border border-border bg-surface px-2.5 text-body text-foreground outline-none transition-colors duration-[120ms] placeholder:text-3 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-50";

export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, className)} {...props} />;
}

export function AmountInput({ className, ...props }: ComponentProps<"input">) {
  return <input inputMode="decimal" autoComplete="off" className={cn(control, "num text-left", className)} {...props} />;
}

export function NativeSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(control, "cursor-pointer pr-1.5", className)} {...props}>
      {children}
    </select>
  );
}

/**
 * Dialog body with the /split look: surface, one soft shadow, title + one quiet line. `size` picks the width from the
 * ui-kit scale (default `md`). With `footer`, the dialog is a column: header, a body that fills the rest (the caller
 * decides what scrolls inside it) and a footer pinned to the bottom edge.
 */
export function Sheet({
  title,
  description,
  children,
  className,
  size = "md",
  footer,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: DialogSize;
  footer?: ReactNode;
} & Omit<ComponentProps<typeof DialogContent>, "title" | "children" | "className">) {
  const heading = (
    <>
      <DialogTitle className="pr-8 text-title font-semibold">{title}</DialogTitle>
      <DialogDescription className={cn("mt-1 text-meta text-2", !description && "sr-only")}>
        {description ?? title}
      </DialogDescription>
    </>
  );
  if (footer !== undefined) {
    return (
      <DialogContent
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-raised p-0 text-body shadow-dialog ring-1 ring-line-strong",
          dialogSize(size),
          className,
        )}
        {...props}
      >
        <div className="shrink-0 px-4 pt-5 sm:px-6 sm:pt-6">{heading}</div>
        <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-6">{children}</div>
        <div className="shrink-0 border-t border-line-soft bg-raised px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">{footer}</div>
      </DialogContent>
    );
  }
  return (
    <DialogContent
      className={cn(
        "max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-2xl bg-raised p-6 text-body shadow-dialog ring-1 ring-line-strong",
        dialogSize(size),
        className,
      )}
      {...props}
    >
      {heading}
      <div className="mt-4">{children}</div>
    </DialogContent>
  );
}

export function SheetActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-wrap items-center justify-end gap-2">{children}</div>;
}
