"use client";

import { CalendarRangeIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";
import { Button, buttonClass } from "./button";

export interface PeriodBarData {
  /** "September 2026", "Jul – Sep 2026". */
  label: string;
  presets: { value: string; label: string; href: string; active: boolean }[];
  prevHref: string;
  /** Null: there is no next period yet (Analysis stops at today). */
  nextHref: string | null;
  /** The custom range GET form: action path, params to carry, prefilled dates. */
  custom: { action: string; keep: [string, string][]; from: string; to: string; open: boolean; error?: string | null; active: boolean };
}

const arrow = buttonClass({ variant: "outline", size: "icon-sm", className: "size-9 text-2 hover:text-foreground" });

/** Client half of PeriodBar: arrows, the presets menu and the custom range form. */
export function PeriodBarClient({ label, presets, prevHref, nextHref, custom }: PeriodBarData) {
  const t = useT();
  const tp = t.period;
  const [open, setOpen] = useState(custom.open);
  return (
    <>
      <nav aria-label={tp.nav} className="inline-flex items-center gap-1">
        <Link href={prevHref} aria-label={tp.prev} className={arrow} scroll={false}>
          <ChevronLeftIcon aria-hidden />
        </Link>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={fmt(tp.choose, { label })}
              className={buttonClass({ variant: "ghost", size: "sm", className: "h-9 min-w-0 gap-1.5 px-2.5 text-foreground" })}
            >
              <span className="truncate">{label}</span>
              <ChevronDownIcon aria-hidden className="size-4 text-2" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52 rounded-xl bg-raised p-1 shadow-dialog ring-1 ring-line-strong">
            {presets.map((p) => (
              <DropdownMenuItem key={p.value} asChild className="h-9 gap-2 text-body">
                <Link href={p.href} scroll={false} aria-current={p.active ? "page" : undefined}>
                  <span className="flex-1">{p.label}</span>
                  {p.active && <CheckIcon aria-hidden className="size-4 text-primary" />}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="h-9 gap-2 text-body" onSelect={() => setOpen(true)}>
              <CalendarRangeIcon aria-hidden className="size-4 text-2" />
              <span className="flex-1">{tp.custom}</span>
              {custom.active && <CheckIcon aria-hidden className="size-4 text-primary" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {nextHref ? (
          <Link href={nextHref} aria-label={tp.next} className={arrow} scroll={false}>
            <ChevronRightIcon aria-hidden />
          </Link>
        ) : (
          <span role="link" aria-label={tp.next} aria-disabled="true" className={cn(arrow, "pointer-events-none opacity-40")}>
            <ChevronRightIcon aria-hidden />
          </span>
        )}
      </nav>
      {open && (
        <form action={custom.action} method="get" aria-label={tp.customForm} className="flex basis-full flex-wrap items-center gap-2 text-body">
          {custom.keep.map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label className="flex items-center gap-2 text-2">
            {tp.from}
            <input
              type="date"
              name="from"
              required
              defaultValue={custom.from}
              aria-label={tp.startDate}
              className="num h-9 rounded-lg border border-border bg-surface px-2.5 text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </label>
          <label className="flex items-center gap-2 text-2">
            {tp.to}
            <input
              type="date"
              name="to"
              required
              defaultValue={custom.to}
              aria-label={tp.endDate}
              className="num h-9 rounded-lg border border-border bg-surface px-2.5 text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </label>
          <Button type="submit" size="sm" className="h-9">
            <CalendarRangeIcon aria-hidden />
            {tp.view}
          </Button>
          <span className="text-meta text-2">{tp.customHint}</span>
          {custom.error && (
            <p role="alert" className={cn("w-full text-meta text-2")}>
              {custom.error}
            </p>
          )}
        </form>
      )}
    </>
  );
}
