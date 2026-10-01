"use client";

import type { ComponentProps } from "react";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

export interface CategoryPillProps extends Omit<ComponentProps<"span">, "children"> {
  /** Stored category name (system names display translated); null renders a dashed "Uncategorized" pill. */
  name: string | null;
  /** Shown instead of "Uncategorized" when name is null. */
  emptyLabel?: string;
}

/**
 * Outlined grey pill with the category label (calm mode: no hue; categories differ by the row's icon tile). Accepts span
 * props and a ref, so it can be a Radix trigger child: `<DropdownMenuTrigger asChild><button><CategoryPill .../></button>`.
 */
export function CategoryPill({ name, emptyLabel, className, ...props }: CategoryPillProps) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex h-[26px] max-w-full items-center justify-center truncate rounded-full border px-2.5 text-meta",
        name ? "border-border text-2" : "border-dashed border-line-strong text-3",
        className,
      )}
      {...props}
    >
      <span className="truncate">{name ? categoryLabel(name, t) : (emptyLabel ?? t.common.uncategorized)}</span>
    </span>
  );
}
