"use client";

import { EllipsisIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui-kit/button";
import { IconTile } from "@/components/ui-kit/icon-tile";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Outlined 13px pill in a row's meta line (environment, "Flex report"). */
export function MetaPill({ children }: { children: ReactNode }) {
  return <span className="rounded-sm border border-border px-1.5 leading-5 text-2">{children}</span>;
}

/**
 * One connected source on Settings > Connections and Assets: 36px tile (42px on phones), name, a meta
 * line whose parts are joined by " · ", optional extra lines, then the row's actions on the right from
 * md and an overflow menu. Rows are 60px (64px on phones) and share one grid, so names, meta and actions
 * line up across the Banks and Brokerages cards.
 */
export function SourceRow({
  icon,
  name,
  meta,
  extra,
  actions,
  menu,
  menuLabel,
  phoneMenu = false,
  dim = false,
  testId,
}: {
  icon: LucideIcon;
  name: ReactNode;
  /** Meta parts, each a node; falsy parts are skipped. */
  meta: ReactNode[];
  /** Secondary lines under the meta (accounts, an error sentence). */
  extra?: ReactNode;
  /** Buttons shown from md; put their phone copies in `menu` with `md:hidden`. */
  actions?: ReactNode;
  /** DropdownMenuItems; the trigger is drawn only when there are some. */
  menu?: ReactNode;
  menuLabel?: string;
  /** Every menu item is a phone copy of an action: from md the trigger keeps its place but is hidden. */
  phoneMenu?: boolean;
  dim?: boolean;
  testId?: string;
}) {
  const parts = meta.filter(Boolean);
  return (
    <li className={cn("flex min-h-16 items-center gap-3 px-4 py-2.5 md:min-h-[60px] md:px-5", dim && "text-2")} data-testid={testId}>
      <IconTile icon={icon} size="responsive" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="truncate text-body font-medium">{name}</div>
        {parts.length > 0 && (
          // Each part carries its " · " on the left; the negative margin plus the clip hide it at the start of every line.
          // A part that renders nothing (yet) is hidden with its separator.
          <div className="overflow-hidden" data-testid="source-meta">
            <div className="-ml-4 flex flex-wrap items-center gap-y-0.5 text-meta text-2">
              {parts.map((p, i) => (
                <span key={i} className="inline-flex items-center before:w-4 before:text-center before:text-3 before:content-['·'] empty:hidden">
                  {p}
                </span>
              ))}
            </div>
          </div>
        )}
        {extra}
      </div>
      {actions && (
        <div className="hidden shrink-0 items-center justify-end gap-2 md:flex" data-testid="source-actions">
          {actions}
        </div>
      )}
      {menu && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={menuLabel} className={cn("-mr-1 shrink-0", phoneMenu && "md:invisible")}>
              <EllipsisIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-xl bg-raised p-1 shadow-dialog ring-1 ring-line-strong">
            {menu}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/** Class for the menu items of a source row (and the phone copies of its actions: add `md:hidden`). */
export const menuItem = "h-9 gap-2 text-body [&_svg]:text-2";
