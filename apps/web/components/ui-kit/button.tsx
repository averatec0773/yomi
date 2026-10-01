import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "soft" | "outline" | "ghost" | "quiet" | "danger";
export type ButtonSize = "md" | "sm" | "icon" | "icon-sm";

const VARIANT: Record<ButtonVariant, string> = {
  /** The one filled button per view. */
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  /** Soft accent: row-level actions (Settle, That's, Record as repayment) and page primaries on phones. */
  soft: "bg-primary-soft text-primary-soft-foreground hover:brightness-[1.04] dark:hover:brightness-110",
  outline: "border border-border bg-surface text-foreground hover:bg-sunken aria-expanded:bg-sunken",
  ghost: "text-2 hover:bg-sunken hover:text-foreground aria-expanded:bg-sunken aria-expanded:text-foreground",
  quiet: "h-auto px-0 text-2 underline-offset-4 hover:text-foreground hover:underline",
  /** Only for the confirm step of an irreversible action (typed disconnect). */
  danger: "bg-neg-soft text-neg hover:brightness-[1.04] dark:hover:brightness-110",
};

const SIZE: Record<ButtonSize, string> = {
  md: "h-10 px-4",
  sm: "h-8 px-3",
  icon: "size-10",
  "icon-sm": "size-8",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A page's filled primary turns soft below md, where the Add button in the tab bar is the filled one. */
  phoneSoft?: boolean;
  /** Render the child (a Link or <a>) with the button look. */
  asChild?: boolean;
}

/** Class string for things that must look like a Button but are not one (a Link inside a menu trigger, a label). */
export function buttonClass({
  variant = "outline",
  size = "md",
  phoneSoft = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; phoneSoft?: boolean; className?: string } = {}): string {
  return cn(
    "hit relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg text-body font-medium whitespace-nowrap transition-colors duration-[120ms] ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    SIZE[size],
    VARIANT[variant],
    variant === "primary" && phoneSoft && "max-md:bg-primary-soft max-md:text-primary-soft-foreground",
    className,
  );
}

/**
 * The one button: 15px / 500, lucide icon first (16px), 40px (`md`) or 32px (`sm`) high with
 * a 44px hit area on phones. One `primary` per view; `phoneSoft` for page primaries (the tab bar Add is filled on
 * phones). Icon-only buttons need `aria-label`.
 */
export function Button({ variant = "outline", size = "md", phoneSoft, asChild = false, className, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? "button")}
      className={buttonClass({ variant, size, phoneSoft, className })}
      {...props}
    />
  );
}
