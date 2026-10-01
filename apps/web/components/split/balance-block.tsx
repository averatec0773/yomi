"use client";

import type { Balance } from "@yomi/contracts";
import { ArrowLeftRightIcon, CalendarCheckIcon, CheckIcon, EllipsisIcon, FileTextIcon, FlagIcon, ReceiptTextIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { Money } from "@/components/money";
import { IconTile } from "@/components/ui-kit/icon-tile";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import type { Dictionary } from "@/i18n/en";
import type { Locale } from "@/i18n/config";
import { dayLabel } from "@/lib/month";
import { RecordSettlementSheet } from "./record-sheet";
import { SettleAllSheet } from "./settle-all-sheet";
import { ClearBeforeSheet, OpeningBalanceSheet } from "./opening-sheet";
import { StatementSheet } from "./statement-sheet";

export interface BalanceBlockProps {
  participantId: number;
  name: string;
  archived: boolean;
  lines: Balance[];
  today: string;
  /** Every currency in the ledger, for the FX pickers. */
  ledgerCurrencies: string[];
}

function metaLine(lines: Balance[], t: Dictionary, locale: Locale): string {
  const b = t.split.balance;
  const parts: string[] = [];
  const open = lines.reduce((n, l) => n + l.openItemCount, 0);
  if (open > 0) parts.push(plural(b.openItems, open));
  const last = lines.map((l) => l.lastSettledOn).filter((d): d is string => Boolean(d)).sort().at(-1);
  parts.push(last ? fmt(b.lastSettled, { date: dayLabel(last, locale) }) : b.neverSettled);
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One person on Split and settle: avatar, name, open items; one hero line per currency (never summed), "To settle with
 * Alex $719.73" or "You pay Li $40.00" (clay), with Statement and Settle. Everything else is in the person menu.
 */
export function BalanceBlock({ participantId, name, archived, lines, today, ledgerCurrencies }: BalanceBlockProps) {
  const t = useT();
  const locale = useLocale();
  const b = t.split.balance;
  const [settle, setSettleState] = useState<{ line: Balance; preselect?: number[] } | null>(null);
  const setSettle = (line: Balance | null, preselect?: number[]) => setSettleState(line ? { line, preselect } : null);
  const [record, setRecord] = useState(false);
  const [statement, setStatement] = useState<Balance | null>(null);
  const [statementRefresh, setStatementRefresh] = useState(0);
  const [opening, setOpening] = useState(false);
  const [clear, setClear] = useState(false);
  const currencies = lines.map((l) => l.currency);

  return (
    <article className="flex flex-col gap-3.5 rounded-xl border border-border bg-surface p-5">
      <header className="flex items-center gap-3">
        <IconTile>{name.slice(0, 1).toUpperCase()}</IconTile>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-title font-semibold">
            {name}
            {archived && <span className="ml-2 text-meta font-normal text-2">{b.archived}</span>}
          </h2>
          {lines.length > 0 && <p className="text-meta text-2">{metaLine(lines, t, locale)}</p>}
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={fmt(b.moreActions, { name })}
              className="hit relative -mr-2 inline-flex size-8 items-center justify-center rounded-lg text-2 transition-colors duration-[120ms] hover:bg-tile hover:text-foreground"
            >
              <EllipsisIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-xl bg-raised p-1 shadow-dialog ring-1 ring-line-strong">
            <DropdownMenuItem className="h-9 gap-2 text-body" onSelect={() => setRecord(true)}>
              <ArrowLeftRightIcon className="size-4 text-2" />
              {b.record}
            </DropdownMenuItem>
            {lines.length > 0 && (
              <DropdownMenuItem className="h-9 gap-2 text-body" asChild>
                <Link href={`/transactions?participantId=${participantId}&show=all`}>
                  <ReceiptTextIcon className="size-4 text-2" />
                  {b.details}
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="h-9 gap-2 text-body" onSelect={() => setOpening(true)}>
              <FlagIcon className="size-4 text-2" />
              {b.setOpening}
            </DropdownMenuItem>
            <DropdownMenuItem className="h-9 gap-2 text-body" onSelect={() => setClear(true)}>
              <CalendarCheckIcon className="size-4 text-2" />
              {b.clearBefore}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {lines.length === 0 ? (
        <div className="border-t border-line-soft pt-3">
          <p className="text-body text-2">{fmt(b.empty, { name })}</p>
          <p className="mt-2 text-body text-2">
            {b.oldDebts}
            <Button variant="quiet" className="ml-1 text-primary" onClick={() => setOpening(true)}>
              {b.setOpening}
            </Button>
          </p>
        </div>
      ) : (
        <ul className="flex flex-col">
          {lines.map((line) => {
            const v = line.owedToMeMinor;
            if (v === 0) {
              return (
                <li key={line.currency} className="flex items-center gap-2 border-t border-line-soft py-3 text-body text-2">
                  <CheckIcon className="size-4 text-2" aria-hidden />
                  {fmt(b.settled, { name })}
                  <span className="text-meta text-2">{line.currency}</span>
                </li>
              );
            }
            return (
              <li key={line.currency} className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line-soft py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-meta text-2">{fmt(v > 0 ? b.toSettle : b.youPay, { name })}</span>
                  <Money
                    minor={v}
                    currency={line.currency}
                    abs
                    tone={v > 0 ? "default" : "neg"}
                    className="justify-start text-hero font-semibold tracking-[-0.02em]"
                  />
                </div>
                <div className="grid w-full grid-cols-2 gap-2.5 md:flex md:w-auto">
                  <Button onClick={() => setStatement(line)} aria-label={fmt(b.statementAria, { name, currency: line.currency })}>
                    <FileTextIcon aria-hidden />
                    {b.statement}
                  </Button>
                  <Button variant="soft" onClick={() => setSettle(line)} aria-label={fmt(b.settleAria, { name, currency: line.currency })}>
                    <CheckIcon aria-hidden />
                    {b.settle}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={settle !== null} onOpenChange={(o) => !o && setSettle(null)}>
        {settle && (
          <SettleAllSheet
            participantId={participantId}
            name={name}
            balance={settle.line}
            today={today}
            currencies={ledgerCurrencies}
            preselect={settle.preselect}
            onDone={() => {
              setSettle(null);
              if (statement) setStatementRefresh((n) => n + 1);
            }}
          />
        )}
      </Dialog>
      <Dialog open={record} onOpenChange={setRecord}>
        {record && (
          <RecordSettlementSheet
            participantId={participantId}
            name={name}
            currencies={currencies}
            ledgerCurrencies={ledgerCurrencies}
            today={today}
            onDone={() => setRecord(false)}
          />
        )}
      </Dialog>
      <Dialog open={opening} onOpenChange={setOpening}>
        {opening && (
          <OpeningBalanceSheet
            participantId={participantId}
            name={name}
            currencies={currencies}
            today={today}
            onDone={() => setOpening(false)}
          />
        )}
      </Dialog>
      <Dialog open={clear} onOpenChange={setClear}>
        {clear && (
          <ClearBeforeSheet
            participantId={participantId}
            name={name}
            currencies={currencies}
            today={today}
            onDone={() => setClear(false)}
          />
        )}
      </Dialog>
      <Dialog open={statement !== null} onOpenChange={(o) => !o && setStatement(null)}>
        {statement && (
          <StatementSheet
            participantId={participantId}
            name={name}
            lines={[statement, ...lines.filter((l) => l.currency !== statement.currency)]}
            refreshKey={statementRefresh}
            onSettle={(currency, ids) => {
              // Opens on top: the statement stays mounted beneath, and closing the settle dialog returns to it.
              const line = lines.find((l) => l.currency === currency);
              if (line) setSettle(line, ids);
            }}
          />
        )}
      </Dialog>
    </article>
  );
}
