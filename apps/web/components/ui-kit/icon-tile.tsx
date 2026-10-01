import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type IconTileSize = "sm" | "md" | "lg" | "responsive";

/**
 * The neutral square behind a grey line icon (categories differ by shape, not hue): category tiles, Tools tiles, empty states, person
 * avatars. `sm` 28px, `md` 36px (desktop rows), `lg` 42px (phone rows), `responsive` 42px on phones and 36px from md.
 * Pass a lucide component as `icon`, or `children` (an initial) instead.
 */
export function IconTile({
  icon: Icon,
  children,
  size = "md",
  className,
}: {
  icon?: LucideIcon;
  children?: ReactNode;
  size?: IconTileSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-tile text-2",
        size === "sm" && "size-7 rounded-md text-meta font-semibold",
        size === "md" && "size-9 rounded-[10px] text-body font-semibold",
        size === "lg" && "size-[42px] rounded-xl text-title font-semibold",
        size === "responsive" && "size-[42px] rounded-xl text-title font-semibold md:size-9 md:rounded-[10px] md:text-body",
        className,
      )}
    >
      {Icon ? (
        <Icon className={cn(size === "sm" ? "size-4" : size === "lg" ? "size-5" : size === "responsive" ? "size-5 md:size-[18px]" : "size-[18px]")} />
      ) : (
        children
      )}
    </span>
  );
}
