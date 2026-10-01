import { InboxIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { IconTile } from "./icon-tile";

export interface EmptyStateProps {
  /** One plain sentence, e.g. "No transactions this month yet." No illustration, no exclamation marks. */
  children: ReactNode;
  /** At most one action (a Link or Button) after the sentence. */
  action?: ReactNode;
  /** Line icon in a neutral tile (default: inbox). */
  icon?: LucideIcon;
  /** `card` (default) is a bordered surface; `inline` sits inside a ListCard or Section card without its own border. */
  variant?: "card" | "inline";
  className?: string;
}

/** Icon tile + one sentence + one optional action, for every empty list and page. */
export function EmptyState({ children, action, icon = InboxIcon, variant = "card", className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-2",
        variant === "card" ? "rounded-xl border border-border bg-surface px-5 py-6" : "px-4 py-5 md:px-5",
        className,
      )}
    >
      <IconTile icon={icon} />
      <p className="min-w-0 flex-1 basis-48">{children}</p>
      {action}
    </div>
  );
}
