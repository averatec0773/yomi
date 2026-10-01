"use client";

import type { DeleteSettlementResult, Settlement } from "@yomi/contracts";
import { ReceiptIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { Money, moneyText } from "@/components/money";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import type { Dictionary } from "@/i18n/en";
import { dayLabel } from "@/lib/month";
import { rateOf, Section, Sheet, SheetActions, useMutation } from "./ui";

const PAGE = 12;

function fxMemo(s: Settlement, t: Dictionary): string | null {
  if (s.originalAmountMinor === null || !s.originalCurrency) return null;
  const orig = moneyText(Math.abs(s.originalAmountMinor), s.originalCurrency);
  const credited = moneyText(Math.abs(s.amountMinor), s.currency);
  return fmt(s.amountMinor > 0 ? t.split.history.received : t.split.history.paid, { orig, credited });
}

/** "Opening: to settle with Roommate" / "Opening: you pay Roommate" for opening balances, else who paid whom. */
function headline(s: Settlement, t: Dictionary): string {
  const h = t.split.history;
  const name = s.participantName;
  if (s.opening) return fmt(s.amountMinor < 0 ? h.openingToSettle : h.openingYouPay, { name });
  return fmt(s.amountMinor > 0 ? h.theyPaid : h.youPaid, { name });
}

// Older clients and core stored a default note on opening balances ("期初余额" / "Opening balance", optionally
// followed by " · extra"); now the row is marked by `opening` alone and the note holds only the extra text.
const OPENING_MARKER = /^(?:期初余额|Opening balance)\s*(·\s*)?/;

/** The note of an opening balance without the legacy default marker, if anything is left. */
function openingExtra(note: string | null): string | null {
  const rest = note?.replace(OPENING_MARKER, "").trim();
  return rest || null;
}

/**
 * FX memo with its rate (both from the settlement's amounts, in the active language), the note, and whether a
 * transfer backs it. Older rows carry the memo as prose in the note ("收到 ¥700.00 抵 $98.00（汇率 7.14）" or
 * "Received ¥700.00 for $98.00 (rate 7.14)"); that prefix is dropped so the memo is not shown twice.
 */
const AUTO_FX_NOTE = /^(?:(?:收到|付出) [^\s（]+ 抵 [^\s（]+(?:（汇率 [\d.]+）)?|(?:Received|Paid) \S+ for \S+(?: \(rate [\d.]+\))?)/;

function detailLine(s: Settlement, memo: string | null, t: Dictionary): string {
  const auto = memo !== null && s.note !== null ? AUTO_FX_NOTE.exec(s.note) : null;
  const note = auto ? s.note!.slice(auto[0].length).replace(/^\s*·?\s*/, "") || null : s.note;
  const rate =
    memo !== null && s.originalAmountMinor !== null && s.originalCurrency
      ? (s.fxRate ?? rateOf(s.amountMinor, s.currency, s.originalAmountMinor, s.originalCurrency)?.toFixed(2) ?? null)
      : null;
  const fxLine = memo !== null && rate ? memo + fmt(t.split.candidates.fxNoteRate, { rate }) : memo;
  const noteHasMemo = !auto && memo !== null && note !== null && note.startsWith(memo);
  return [noteHasMemo ? note : fxLine, noteHasMemo ? null : note, s.transactionId ? t.split.history.fromTransfer : null]
    .filter(Boolean)
    .join(" · ");
}

function DeleteSheet({ s, onDone }: { s: Settlement; onDone: () => void }) {
  const { run, busy } = useMutation();
  const t = useT();
  const locale = useLocale();
  const h = t.split.history;
  return (
    <Sheet
      title={s.opening ? h.deleteOpeningTitle : h.deleteTitle}
      description={s.transactionId ? h.deleteLinked : h.deletePlain}
      size="sm"
    >
      <p className="rounded-md bg-sunken px-4 py-3 text-body">
        {dayLabel(s.settledOn, locale)} · {headline(s, t)}{" "}
        <Money minor={s.amountMinor} currency={s.currency} abs className="font-medium" />
      </p>
      <SheetActions>
        <DialogClose asChild>
          <Button variant="ghost">{t.common.cancel}</Button>
        </DialogClose>
        <Button
          variant="outline"
          className="text-neg"
          disabled={busy}
          onClick={async () => {
            const out = await run(() => apiFetch<DeleteSettlementResult>(`/settlements/${s.id}`, { method: "DELETE" }));
            if (out) {
              toast(h.deleted);
              onDone();
            }
          }}
        >
          <Trash2Icon aria-hidden />
          {busy ? t.common.deleting : t.common.delete}
        </Button>
      </SheetActions>
    </Sheet>
  );
}

/** All settlements, newest first. Signed from my side: + means money came to me. */
export function SettlementHistory({ settlements }: { settlements: Settlement[] }) {
  const t = useT();
  const locale = useLocale();
  const h = t.split.history;
  const [all, setAll] = useState(false);
  const [target, setTarget] = useState<Settlement | null>(null);
  const rows = all ? settlements : settlements.slice(0, PAGE);

  return (
    <Section card icon={<ReceiptIcon />} title={h.title} count={settlements.length || undefined}>
      {settlements.length === 0 ? (
        <p className="border-t border-line-soft py-4 text-body text-2">{h.empty}</p>
      ) : (
        <ul>
          {rows.map((s) => {
            const memo = fxMemo(s, t);
            const detail = s.opening ? openingExtra(s.note) : memo || s.note || s.transactionId ? detailLine(s, memo, t) : null;
            return (
              <li key={s.id} className="group flex items-center gap-3 border-t border-line-soft py-2.5">
                <span className="w-[4.5rem] shrink-0 text-meta text-2">{dayLabel(s.settledOn, locale)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body">{headline(s, t)}</p>
                  {detail && <p className="truncate text-meta text-2">{detail}</p>}
                </div>
                {s.opening ? (
                  <Money minor={s.amountMinor} currency={s.currency} abs className="text-body" />
                ) : (
                  <Money minor={s.amountMinor} currency={s.currency} sign="inflow" className="text-body" />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2 opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => setTarget(s)}
                  aria-label={fmt(h.deleteAria, { date: dayLabel(s.settledOn, locale), what: s.opening ? h.whatOpening : h.whatSettlement })}
                >
                  {t.common.delete}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {settlements.length > PAGE && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? t.common.collapse : fmt(h.showAll, { count: settlements.length })}
        </Button>
      )}
      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        {target && <DeleteSheet s={target} onDone={() => setTarget(null)} />}
      </Dialog>
    </Section>
  );
}
