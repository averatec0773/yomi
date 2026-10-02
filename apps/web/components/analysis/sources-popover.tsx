"use client";

import { DatabaseIcon, FileInputIcon } from "lucide-react";
import Link from "next/link";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buttonClass } from "@/components/ui-kit/button";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

export interface SourceLine {
  key: string;
  name: string;
  /** "Through Sep 24", "Last pasted Sep 12", "No data yet". */
  detail: string;
  state: "current" | "behind" | "error" | "paused" | "never";
  /** "Time for a new Alipay export." for exports older than a week. */
  reminder: string | null;
}

/**
 * The quiet "Sources" button in the Analysis header: every source with the day its data reaches and its state, plus a
 * reminder for exports older than a week. Text only, no badges or colors beyond text-2 / text-3.
 */
export function SourcesPopover({ sources }: { sources: SourceLine[] }) {
  const t = useT().analysis.sources;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={buttonClass({ variant: "outline", size: "sm" })} data-testid="sources-button">
          <DatabaseIcon aria-hidden />
          {t.button}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-32px)] p-0" aria-label={t.title}>
        <div className="border-b border-line-soft px-4 py-3 text-body font-medium">{t.title}</div>
        {sources.length === 0 ? (
          <p className="px-4 py-3 text-meta text-2">{t.none}</p>
        ) : (
          <ul className="divide-y divide-line-soft" data-testid="sources-list">
            {sources.map((s) => (
              <li key={s.key} className="flex flex-col gap-0.5 px-4 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-body">{s.name}</span>
                  <span className={cn("shrink-0 text-meta", s.state === "current" ? "text-3" : "text-2")}>{t.states[s.state]}</span>
                </div>
                <span className="num text-meta text-2">{s.detail}</span>
                {s.reminder && (
                  <Link href="/import" className="inline-flex items-center gap-1 text-meta text-primary underline-offset-4 hover:underline">
                    <FileInputIcon aria-hidden className="size-3.5" />
                    {s.reminder}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
