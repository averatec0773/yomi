import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ListCardProps extends Omit<ComponentProps<"section">, "title"> {
  /** Header title (an h2, or `heading`). Without it the card has no header. */
  title?: ReactNode;
  /** Heading level of the title: h3 when the card sits under a section's own h2 (Settings panels). */
  heading?: "h2" | "h3";
  icon?: LucideIcon;
  /** Quiet count after the title. */
  count?: number;
  /** Quiet note on the right of the header ("25 new", column captions). */
  aside?: ReactNode;
  /** A small action on the right of the header. */
  action?: ReactNode;
  /** Classes for the body that holds the rows. */
  bodyClassName?: string;
  /** Full-bleed on phones (the transaction list): no side border or radius below md. */
  bleed?: boolean;
}

/**
 * Bordered surface list for records (transactions, categories, largest, import history, connections, holdings, rules):
 * optional header (icon, title, count, aside, action), rows divided by `line-soft` hairlines.
 */
export function ListCard({ title, heading: Heading = "h2", icon: Icon, count, aside, action, children, className, bodyClassName, bleed = false, ...props }: ListCardProps) {
  return (
    <section
      className={cn(
        "min-w-0 overflow-clip border border-border bg-surface",
        bleed ? "-mx-gutter border-x-0 md:mx-0 md:rounded-xl md:border-x" : "rounded-xl",
        className,
      )}
      {...props}
    >
      {title !== undefined && (
        <div className="flex min-h-12 items-center gap-2.5 border-b border-line-soft px-4 py-2.5 md:px-5">
          {Icon && <Icon aria-hidden className="size-[18px] shrink-0 text-2" />}
          <Heading className="min-w-0 flex-1 truncate text-title font-semibold">
            {title}
            {count !== undefined && <span className="ml-1.5 text-meta font-normal text-2">{count}</span>}
          </Heading>
          {aside !== undefined && <span className="shrink-0 text-meta text-2">{aside}</span>}
          {action}
        </div>
      )}
      <div className={cn("divide-y divide-line-soft", bodyClassName)}>{children}</div>
    </section>
  );
}
