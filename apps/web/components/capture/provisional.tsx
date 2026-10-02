"use client";

import type { ProvisionalTotals } from "@yomi/contracts";
import { CircleDashedIcon, HourglassIcon } from "lucide-react";
import { moneyText } from "@/components/money";
import { plural } from "@/i18n";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

/**
 * The quiet mark on a row no statement has confirmed yet: CircleDashed "Provisional", or Hourglass "Card hold" (not
 * counted). 13px meta text with a 14px icon; the amount next to it stays plain.
 */
export function ProvisionalLabel({ kind, className }: { kind: "capture" | "hold"; className?: string }) {
  const c = useT().capture;
  const Icon = kind === "hold" ? HourglassIcon : CircleDashedIcon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-meta text-2", className)} title={kind === "hold" ? c.holdTitle : c.provisionalTitle}>
      <Icon className="size-3.5" aria-hidden />
      {kind === "hold" ? c.hold : c.provisional}
    </span>
  );
}

/**
 * One 13px text-2 line under a total: "incl. $23.50 provisional (1) · 1 card hold not counted, $28.79". Per currency,
 * never summed across currencies; nothing when the total rests on no capture.
 */
export function ProvisionalNote({ totals, currency, className }: { totals: ProvisionalTotals; currency: string; className?: string }) {
  const c = useT().capture;
  const parts = [
    totals.provisional.count > 0 ? plural(c.inclProvisional, totals.provisional.count, { amount: moneyText(totals.provisional.minor, currency) }) : null,
    totals.holds.count > 0 ? plural(c.holdsNotCounted, totals.holds.count, { amount: moneyText(totals.holds.minor, currency) }) : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className={cn("text-meta text-2", className)} data-testid="provisional-note">
      {parts.join(" · ")}
    </p>
  );
}
