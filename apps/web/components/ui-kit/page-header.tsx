import type { ReactNode } from "react";
import { ToolsCrumb } from "@/components/shell/tools-crumb";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: ReactNode;
  /** Right after the title: the PeriodBar, or a label in the same slot (Assets "As of"). */
  controls?: ReactNode;
  /** Right side: search and buttons. At most one filled primary, with `phoneSoft` (the tab bar Add is filled on phones). */
  actions?: ReactNode;
  /** One short dynamic line under the title (13px text-2), or nothing. Pages carry no static descriptions. */
  meta?: ReactNode;
  className?: string;
}

/**
 * The only page header: crumb (automatic under Tools) · 24px title · controls · spacer · actions,
 * then an optional meta line. Every page starts its title at the same x (content is left-aligned, never centered).
 */
export function PageHeader({ title, controls, actions, meta, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-6 flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0">
          <ToolsCrumb />
          <h1 className="text-page font-semibold tracking-[-0.01em]">{title}</h1>
        </div>
        {controls && <div className="flex min-w-0 flex-wrap items-center gap-2">{controls}</div>}
        {actions && <div className="flex w-full flex-wrap items-center gap-2 md:ml-auto md:w-auto">{actions}</div>}
      </div>
      {meta && <p className="text-meta text-2">{meta}</p>}
    </header>
  );
}
