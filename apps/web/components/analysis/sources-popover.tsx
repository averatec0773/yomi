"use client";

import { DatabaseIcon, FileInputIcon } from "lucide-react";
import Link from "next/link";
import { Money } from "@/components/money";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buttonClass } from "@/components/ui-kit/button";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

export interface SourceLine {
  key: string;
  name: string;
  /** "Through Sep 24", "Last pasted Sep 12", "No data yet"; null for rows no listed source covers (added by hand). */
  detail: string | null;
  state: "current" | "behind" | "error" | "paused" | "never" | null;
  /** "Time for a new Alipay export." for exports older than a week. */
  reminder: string | null;
  /**
   * The period's rows from this source: spending per currency, or income when it has no spending. Count 0 shows
   * "—"; null (investment sources) shows nothing.
   */
  totals: { count: number; amounts: { minor: number; currency: string }[]; income: boolean } | null;
}

/**
 * The quiet "Sources" button in the Analysis header: every source with the day its data reaches and its state, the
 * rows and amount it adds to the period, plus a reminder for exports older than a week. Text only, no badges or
 * colors beyond text-2 / text-3 (income in the inflow green).
 */
export function SourcesPopover({ sources }: { sources: SourceLine[] }) {
  const t = useT().analysis.sources;
  const codes = new Set(sources.flatMap((s) => s.totals?.amounts.map((a) => a.currency) ?? [])).size > 1;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={buttonClass({ variant: "outline", size: "sm" })} data-testid="sources-button">
          <DatabaseIcon aria-hidden />
          {t.button}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={16} className="w-96 max-w-[calc(100vw-32px)] p-0" aria-label={t.title}>
        {sources.length === 0 ? (
          <>
            <div className="border-b border-line-soft px-4 py-3 text-body font-medium">{t.title}</div>
            <p className="px-4 py-3 text-meta text-2">{t.none}</p>
          </>
        ) : (
          // One grid for the header and every row, so counts and amounts line up in columns.
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3">
            <div className="col-span-3 grid grid-cols-subgrid items-baseline border-b border-line-soft px-4 py-3">
              <span className="text-body font-medium">{t.title}</span>
              <span className="text-right text-hint text-3">{t.count}</span>
              <span className="text-right text-hint text-3">{t.amount}</span>
            </div>
            <ul className="col-span-3 grid grid-cols-subgrid divide-y divide-line-soft" data-testid="sources-list">
              {sources.map((s) => (
                <li key={s.key} className="col-span-3 grid grid-cols-subgrid items-baseline gap-y-0.5 px-4 py-2.5">
                  <span className="min-w-0 truncate text-body">{s.name}</span>
                  <span className="num text-meta text-2" data-testid="source-count">
                    {s.totals && s.totals.count > 0 ? s.totals.count : null}
                  </span>
                  <span className="num flex flex-wrap justify-end gap-x-1.5 text-meta" data-testid="source-amount">
                    {s.totals &&
                      (s.totals.count === 0 ? (
                        <span className="text-3">—</span>
                      ) : (
                        s.totals.amounts.map((a, i) => (
                          <span key={a.currency} className="whitespace-nowrap">
                            {i > 0 && <span className="mr-1.5 text-3">·</span>}
                            <Money minor={a.minor} currency={a.currency} sign={s.totals!.income ? "inflow" : "plain"} showCode={codes} />
                          </span>
                        ))
                      ))}
                  </span>
                  {s.detail && (
                    <span className="col-span-3 text-meta text-2">
                      <span className="num">{s.detail}</span>
                      {s.state && <span className={cn(s.state === "current" ? "text-3" : "text-2")}> · {t.states[s.state]}</span>}
                    </span>
                  )}
                  {s.reminder && (
                    <Link href="/import" className="col-span-3 inline-flex items-center gap-1 text-meta text-primary underline-offset-4 hover:underline">
                      <FileInputIcon aria-hidden className="size-3.5" />
                      {s.reminder}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
