import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export interface FilterChipProps extends ComponentProps<"button"> {
  icon: LucideIcon;
  /** The filter is on: soft accent fill. */
  active?: boolean;
  /** Opens a menu: adds a chevron. Wrap in `DropdownMenuTrigger asChild`. */
  menu?: boolean;
}

/**
 * Filter chip (an icon on every chip): 36px pill, 15px text, 44px hit area on phones. Toggle chips pass
 * `aria-pressed`; menu chips go inside a `DropdownMenuTrigger asChild`.
 */
export function FilterChip({ icon: Icon, active = false, menu = false, className, children, type = "button", ...props }: FilterChipProps) {
  return (
    <button
      type={type}
      className={cn(
        "hit relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-body whitespace-nowrap transition-colors duration-[120ms] ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "border-transparent bg-primary-soft text-primary-soft-foreground" : "border-border bg-surface text-2 hover:text-foreground",
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="max-w-40 truncate">{children}</span>
      {menu && <ChevronDownIcon aria-hidden className="-mr-0.5 size-3.5 shrink-0 opacity-60" />}
    </button>
  );
}
