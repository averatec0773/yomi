"use client";

import { HistoryIcon } from "lucide-react";
import { IBKR_HISTORY_DAYS, type InvestSyncResult } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { toastInvestSync } from "@/components/assets/labels";
import { Sheet, TextInput } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { errorText, noticeText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { dayLabel } from "@/lib/month";

/** Whole days within IBKR's limit, else null. */
export function parseHistoryDays(v: string): number | null {
  const s = v.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= IBKR_HISTORY_DAYS.min && n <= IBKR_HISTORY_DAYS.max ? n : null;
}

/**
 * Settings > Connections > Interactive Brokers > "Pull history…" (sm dialog): how many days of IBKR activity to
 * pull (1 to 365, default 365, IBKR's limit), POST /api/invest/ibkr/history. A refusal (pulled less than 10
 * minutes ago, 30 minutes after a failure, already running) or a failed pull stays in the dialog as a calm
 * sentence; success toasts the window and the new transactions, then closes.
 */
export function IbkrHistoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <IbkrHistorySheet onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function IbkrHistorySheet({ onDone }: { onDone: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const i = t.connections.ibkr;
  const [value, setValue] = useState(String(IBKR_HISTORY_DAYS.default));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = parseHistoryDays(value);
  const invalid = days == null ? errorText({ code: "invest_ibkr_history_days_invalid", params: { min: IBKR_HISTORY_DAYS.min, max: IBKR_HISTORY_DAYS.max } }, t) : null;

  async function pull() {
    if (days == null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<InvestSyncResult>("/api/invest/ibkr/history", { json: { days }, silent: true });
      const item = r.results.find((x) => x.provider === "ibkr");
      if (item?.range) {
        toast.success(
          plural(i.historyDone, item.transactionsNew, {
            from: dayLabel(item.range.from, locale, { year: true }),
            to: dayLabel(item.range.to, locale, { year: true }),
          }),
        );
        if (item.stale && item.expectedAsOf) toast.info(fmt(t.assets.ibkrStale, { date: dayLabel(item.expectedAsOf, locale) }), { duration: 10_000 });
        if (item.warnings.length) toast.warning(item.warnings.map((w) => noticeText(w, t)).join("\n"));
      } else {
        toastInvestSync(r, t, locale);
      }
      router.refresh();
      onDone();
    } catch (e) {
      setError(errorText(e, t));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <DialogClose asChild>
        <Button variant="ghost">{t.common.cancel}</Button>
      </DialogClose>
      <Button variant="primary" onClick={() => void pull()} disabled={busy || days == null} data-testid="ibkr-history-pull">
        <HistoryIcon aria-hidden />
        {busy ? i.historyPulling : i.historyPull}
      </Button>
    </div>
  );

  return (
    <Sheet size="sm" title={i.historyTitle} description={i.historyDescription} footer={footer} data-testid="ibkr-history-dialog">
      <form
        className="flex flex-col gap-3 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          void pull();
        }}
      >
        <label className="flex max-w-40 flex-col gap-1">
          <span className="text-meta text-2">{i.historyDays}</span>
          <TextInput
            type="number"
            inputMode="numeric"
            min={IBKR_HISTORY_DAYS.min}
            max={IBKR_HISTORY_DAYS.max}
            step={1}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            aria-invalid={invalid != null}
            aria-describedby="ibkr-history-hint"
            className="num h-10"
            data-testid="ibkr-history-days"
          />
        </label>
        <p id="ibkr-history-hint" className="text-meta text-2">
          {i.historyHint}
        </p>
        <p className="text-meta text-2">{i.historyNote}</p>
        <p role="status" className="text-meta text-foreground" data-testid="ibkr-history-error">
          {invalid ?? error}
        </p>
      </form>
    </Sheet>
  );
}
