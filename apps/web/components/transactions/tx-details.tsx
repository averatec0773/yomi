"use client";

import type { CaptureInfo, ResolveResult } from "@yomi/contracts";
import { localDate } from "@yomi/core/time";
import { dialogSize } from "@/components/ui-kit/dialog-size";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { Money } from "@/components/money";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { fmt } from "@/i18n";
import { accountLabel } from "@/i18n/accounts";
import { useLocale, useT } from "@/i18n/client";
import { sourceTermLabel } from "@/i18n/source-terms";
import { dayLabel } from "@/lib/month";
import { beijingDateIfDifferent, localTimeOf, useTimeZone } from "@/lib/time-zone";
import type { Tx } from "./types";

export function TxDetails({ tx, onClose }: { tx: Tx | null; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const router = useRouter();
  const d = t.transactions.details;
  const booked = tx ? beijingDateIfDifferent(tx) : null;
  const none = t.common.none;
  /** As imported, plus the term in the UI language when it differs: 商户消费 (Merchant payment). */
  const withTerm = (raw: string) => {
    const label = sourceTermLabel(raw, t);
    return label && label !== raw.trim() ? `${raw} (${label})` : raw;
  };
  /** The capture behind the row: "SMS, Oct 1 12:26", then where it stands ("Confirmed by ICBC credit card row #812 · Undo"). */
  const captureRows = (c: CaptureInfo): [string, React.ReactNode][] => {
    const cd = t.capture.details;
    const source = c.authoritySource ? (t.transactions.sources[c.authoritySource as keyof typeof t.transactions.sources] ?? c.authoritySource) : "";
    const state =
      c.authorityId != null && c.state === "confirmed"
        ? fmt(cd.confirmedBy, { source, id: c.authorityId })
        : c.authorityId != null && c.state === "superseded"
          ? fmt(cd.supersededBy, { source, id: c.authorityId })
          : c.state === "confirmed"
            ? cd.keptFinal
            : cd.states[c.state];
    const when = c.resolvedAt ? ` · ${dayLabel(localDate(c.resolvedAt, timeZone), locale)}` : "";
    return [
      [cd.title, `${t.capture.kinds[c.kind]}, ${dayLabel(localDate(c.occurredAt, timeZone), locale)} ${localTimeOf({ occurredAt: c.occurredAt, source: "sms" }, timeZone)}`],
      [
        cd.state,
        <span key="c" data-testid="tx-capture-state">
          {state}
          {when}
          {c.canUndo && c.state !== "provisional" && (
            <>
              {" · "}
              <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => void undoCapture(c.id)}>
                {cd.undo}
              </button>
            </>
          )}
        </span>,
      ],
    ];
  };
  async function undoCapture(id: number) {
    try {
      await apiFetch<ResolveResult>(`/captures/${id}/undo`, { method: "POST" });
      toast(t.transactions.toastUndone);
      onClose();
      router.refresh();
    } catch {
      /* apiFetch toasted */
    }
  }
  const rows: [string, React.ReactNode][] = tx
    ? [
        [
          d.time,
          <span key="t">
            {`${tx.occurredOn} ${localTimeOf(tx, timeZone)}`}
            {booked && (
              <span className="block text-meta text-2" data-testid="tx-booked-beijing">
                {fmt(d.bookedBeijing, { date: dayLabel(booked, locale) })}
              </span>
            )}
          </span>,
        ],
        [d.amount, <Money key="a" minor={tx.amountMinor} currency={tx.currency} showCode />],
        ...(tx.originalAmountMinor != null && tx.originalCurrency
          ? ([[d.originalAmount, <Money key="o" minor={tx.originalAmountMinor} currency={tx.originalCurrency} showCode />]] as [string, React.ReactNode][])
          : []),
        [d.kind, `${t.common.kinds[tx.kind]}${tx.status === "closed" ? d.closedSuffix : ""}`],
        [d.source, t.transactions.sources[tx.source] ?? tx.source],
        ...(tx.importBatchId != null
          ? ([
              [
                d.importBatch,
                <Link key="b" href="/import" className="text-primary underline-offset-4 hover:underline">
                  #{tx.importBatchId}
                </Link>,
              ],
            ] as [string, React.ReactNode][])
          : []),
        [d.account, tx.accountName ? accountLabel(tx.accountName, t) : d.noAccount],
        [d.counterparty, tx.counterpartyRaw || none],
        [d.rawDescription, withTerm(tx.description) || none],
        ...(tx.sourceCategory ? ([[d.sourceCategory, withTerm(tx.sourceCategory)]] as [string, React.ReactNode][]) : []),
        [t.common.note, tx.note || none],
        [d.duplicate, tx.duplicateOfId != null ? fmt(d.duplicateOf, { id: tx.duplicateOfId }) : t.common.no],
        [d.edited, tx.userEditedAt ? tx.userEditedAt.replace("T", " ").slice(0, 16) : t.common.no],
        ...(tx.capture ? captureRows(tx.capture) : []),
        [d.id, `#${tx.id}`],
      ]
    : [];
  return (
    <Dialog open={tx !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={`shadow-dialog ${dialogSize("sm")}`}>
        <DialogTitle className="text-title font-medium">{tx?.merchant || d.title}</DialogTitle>
        <DialogDescription className="text-meta text-2">{d.description}</DialogDescription>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 border-t border-border text-body">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="border-b border-border py-1.5 text-2">{k}</dt>
              <dd className="min-w-0 border-b border-border py-1.5 break-words [&_.num]:justify-start">{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
