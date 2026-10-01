"use client";

import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { categoryIcon, CategoryTile } from "@/components/category-icon";
import { CategoryPill } from "@/components/category-pill";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmt } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";
import type { Category, Tx } from "./types";

/** Categories that fit a row kind (same rule as core update.ts `fits`). */
export function categoriesFor(kind: Tx["kind"], categories: readonly Category[]): Category[] {
  if (kind === "expense") return categories.filter((c) => c.kind === "expense");
  if (kind === "income") return categories.filter((c) => c.kind === "income");
  return [...categories];
}

export function CategoryMenu({
  tx,
  categories,
  open,
  onOpenChange,
  onPick,
  variant = "pill",
}: {
  tx: Tx;
  categories: Category[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (categoryId: number, applyToMerchant: boolean) => void;
  /** pill: the outlined pill in the desktop row; tile: the row's icon tile (phones). */
  variant?: "pill" | "tile";
}) {
  const t = useT();
  const [applyToMerchant, setApplyToMerchant] = useState(false);
  const options = categoriesFor(tx.kind, categories);
  const dim = tx.kind === "transfer" || tx.status !== "ok" || tx.duplicateOfId != null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={fmt(t.transactions.categoryMenu.aria, { name: tx.categoryName ? categoryLabel(tx.categoryName, t) : t.common.uncategorized })}
          className={cn(
            "inline-flex max-w-full rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            variant === "tile" && "hit relative rounded-xl",
            dim && "opacity-60",
          )}
        >
          {variant === "tile" ? (
            <CategoryTile name={tx.categoryName} kind={tx.kind} size="lg" />
          ) : (
            <CategoryPill name={tx.categoryName} className="w-[124px] cursor-pointer transition-colors duration-[120ms] hover:border-line-strong hover:text-foreground" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-80 rounded-xl bg-raised p-1.5 shadow-dialog ring-1 ring-line-strong" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="grid grid-cols-2 gap-0.5">
          {options.map((c) => {
            const Icon = categoryIcon(c.name);
            return (
            <DropdownMenuItem
              key={c.id}
              className={cn("h-9 gap-2 px-2 text-body", c.id === tx.categoryId && "bg-primary-soft text-primary-soft-foreground focus:bg-primary-soft focus:text-primary-soft-foreground")}
              aria-current={c.id === tx.categoryId || undefined}
              onSelect={() => {
                if (c.id !== tx.categoryId || applyToMerchant) onPick(c.id, applyToMerchant);
                setApplyToMerchant(false);
              }}
            >
              <Icon className="size-4 shrink-0 text-2" />
              <span className="truncate">{categoryLabel(c.name, t)}</span>
            </DropdownMenuItem>
            );
          })}
        </div>
        {tx.merchant && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={applyToMerchant}
              onCheckedChange={(v) => setApplyToMerchant(v === true)}
              onSelect={(e) => e.preventDefault()}
              className="h-9 gap-2 pr-2 text-meta text-2 [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
            >
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                  applyToMerchant ? "border-primary bg-primary text-primary-foreground" : "border-foreground/30",
                )}
              >
                {applyToMerchant && <CheckIcon className="size-3" />}
              </span>
              <span className="truncate">{t.transactions.categoryMenu.applyToMerchant}</span>
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
