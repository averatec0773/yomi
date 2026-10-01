"use client";

import { FileDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { buttonClass } from "@/components/ui-kit/button";
import { useLocale, useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

/**
 * "Export CSV" download link for an /api/export/*.csv URL. Client component, usable from server pages.
 * Adds `locale` (unless the href sets it) so headers and labels come out in the UI language. Default: a quiet text link
 * (under lists, in dialogs). `compact`: an outline button for page header actions, icon-only on phones.
 */
export function CsvLink({ href, className, children, compact = false, ...props }: ComponentProps<"a"> & { href: string; compact?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const withLocale = /[?&]locale=/.test(href) ? href : `${href}${href.includes("?") ? "&" : "?"}locale=${encodeURIComponent(locale)}`;
  const label = children ?? t.common.exportCsv;
  if (compact) {
    return (
      <a
        href={withLocale}
        download
        aria-label={typeof label === "string" ? label : undefined}
        className={buttonClass({ variant: "outline", className: cn("max-md:size-10 max-md:px-0", className) })}
        {...props}
      >
        <FileDownIcon aria-hidden />
        <span className="max-md:sr-only">{label}</span>
      </a>
    );
  }
  return (
    <a
      href={withLocale}
      download
      className={cn(
        "hit relative inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-meta text-2 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      <FileDownIcon className="size-3.5 shrink-0" aria-hidden />
      {label}
    </a>
  );
}
