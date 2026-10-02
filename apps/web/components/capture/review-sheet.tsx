"use client";

import type { BulkReviewAction, MatchCandidate, ResolveResult, ReviewAction, ReviewItem, ReviewList } from "@yomi/contracts";
import { InboxIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Money, moneyText } from "@/components/money";
import { Button } from "@/components/ui-kit/button";
import { dialogSize } from "@/components/ui-kit/dialog-size";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { fmt, plural } from "@/i18n";
import type { Dictionary } from "@/i18n/en";
import { useLocale, useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { dayLabel } from "@/lib/month";
import { localTimeOf, useTimeZone } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

/** Phones get the sheet at full height, thumb-reachable, with the bulk bar at its foot. */
const PHONE_FULL =
  "max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:ring-0";

/** Bulk actions each type allows (choosing a candidate is never bulk). */
const BULK: Record<ReviewItem["type"], BulkReviewAction[]> = {
  ambiguous: ["keep_separate", "discard"],
  near_miss: ["keep_separate", "discard"],
  stale: ["keep_final", "discard"],
  amount_changed: [],
};

type Sheet = Dictionary["capture"]["sheet"];

function bulkLabel(s: Sheet, action: BulkReviewAction): string {
  return { keep_separate: s.actions.keepSeparate, keep_final: s.actions.keepFinal, discard: s.actions.discard }[action];
}

/** "1 day later", "same day", "2 days earlier". */
function dayShift(s: Sheet, days: number): string {
  if (days === 0) return s.sameDay;
  return days > 0 ? plural(s.daysLater, days) : plural(s.daysEarlier, -days);
}

/** The review queue as a dialog (desktop md 640) or a full-height sheet (phones). Loads the queue when it opens. */
export function ReviewSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <ReviewBody />}
    </Dialog>
  );
}

function ReviewBody() {
  const t = useT();
  const s = t.capture.sheet;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [list, setList] = useState<ReviewList | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await apiFetch<ReviewList>("/review");
      setList(next);
      setSelected((sel) => new Set([...sel].filter((id) => next.items.some((i) => i.captureId === id))));
    } catch {
      /* apiFetch toasted */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
    startTransition(() => router.refresh());
  }, [load, router]);

  const undo = useCallback(
    async (ids: number[]) => {
      try {
        for (const id of [...ids].reverse()) await apiFetch<ResolveResult>(`/captures/${id}/undo`, { method: "POST" });
        toast(t.transactions.toastUndone);
      } catch {
        /* apiFetch toasted */
      }
      await refresh();
    },
    [refresh, t],
  );

  const run = useCallback(
    async (ids: number[], message: string, send: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await send();
        toast.success(message, { action: { label: t.common.undo, onClick: () => void undo(ids) } });
        await refresh();
      } catch {
        /* apiFetch toasted */
      } finally {
        setBusy(false);
      }
    },
    [refresh, undo, t],
  );

  const act = (item: ReviewItem, action: ReviewAction, candidateId?: number) =>
    run([item.captureId], s.toasts[action], () => apiFetch<ResolveResult>(`/review/${item.captureId}`, { json: { action, candidateId } }));

  const items = list?.items ?? [];
  const chosen = items.filter((i) => selected.has(i.captureId));
  const bulkActions = (["keep_separate", "keep_final", "discard"] as const).filter((a) => chosen.length > 0 && chosen.every((i) => BULK[i.type].includes(a)));
  const bulk = (action: BulkReviewAction) => {
    const ids = chosen.map((i) => i.captureId);
    void run(ids, plural(s.bulkToasts[action], ids.length), async () => {
      await apiFetch<ResolveResult>("/review/bulk", { json: { captureIds: ids, action } });
      setSelected(new Set());
    });
  };

  return (
    <DialogContent
      className={cn("flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-raised p-0 text-body shadow-dialog ring-1 ring-line-strong", dialogSize("md"), PHONE_FULL)}
      data-testid="review-sheet"
      data-toast-actions
      onInteractOutside={(e) => {
        // The toast's Undo sits outside the sheet; using it must not close the sheet.
        if (e.target instanceof Element && e.target.closest("[data-sonner-toaster]")) e.preventDefault();
      }}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-line-soft py-3.5 pr-12 pl-4 sm:pl-5">
        <DialogTitle className="text-title font-semibold">{s.title}</DialogTitle>
        {list && <span className="num text-meta text-2">{list.total}</span>}
        <span className="flex-1" />
        {items.length > 0 && (
          <Button
            variant="quiet"
            className="text-meta text-primary"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
          >
            {selecting ? s.done : s.select}
          </Button>
        )}
      </div>
      <DialogDescription className="sr-only">{s.description}</DialogDescription>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list && items.length === 0 && (
          <EmptyState icon={InboxIcon} variant="inline">
            {s.empty}
          </EmptyState>
        )}
        {items.map((item) => (
          <Item
            key={item.captureId}
            item={item}
            busy={busy}
            selecting={selecting}
            checked={selected.has(item.captureId)}
            onCheck={(on) =>
              setSelected((sel) => {
                const next = new Set(sel);
                if (on) next.add(item.captureId);
                else next.delete(item.captureId);
                return next;
              })
            }
            onAct={(action, candidateId) => void act(item, action, candidateId)}
          />
        ))}
      </div>
      {selecting && chosen.length > 0 && (
        <div
          role="toolbar"
          aria-label={s.bulkLabel}
          className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line-soft bg-raised px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5"
        >
          <span className="flex-1 text-body text-2">{fmt(s.selected, { count: chosen.length })}</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            {s.clear}
          </Button>
          {bulkActions.map((a) => (
            <Button key={a} size="sm" disabled={busy} onClick={() => bulk(a)}>
              {bulkLabel(s, a)}
            </Button>
          ))}
        </div>
      )}
    </DialogContent>
  );
}

function Item({
  item,
  busy,
  selecting,
  checked,
  onCheck,
  onAct,
}: {
  item: ReviewItem;
  busy: boolean;
  selecting: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onAct: (action: ReviewAction, candidateId?: number) => void;
}) {
  const t = useT();
  const s = t.capture.sheet;
  const locale = useLocale();
  const timeZone = useTimeZone();
  const [pick, setPick] = useState<number | null>(item.candidates[0]?.transactionId ?? null);
  const c = item.capture;
  const lateOnly = item.type === "near_miss" && item.candidates.every((x) => x.reasons.includes("amount"));
  const title = lateOnly ? s.types.near_miss_time : s.types[item.type];
  const summary = [
    t.capture.kinds[c.kind],
    c.last4 ? fmt(s.card, { last4: c.last4 }) : null,
    `${dayLabel(c.occurredOn, locale)}, ${localTimeOf({ occurredAt: c.occurredAt, source: c.kind }, timeZone)}`,
    `${moneyText(Math.abs(c.amountMinor), c.currency)}${c.hold ? ` ${s.holdSuffix}` : ""}`,
    item.stale?.reason === "covered" ? fmt(s.covered, { date: dayLabel(item.stale.through, locale) }) : null,
    item.stale?.reason === "age" ? plural(s.age, item.stale.days) : null,
  ].filter(Boolean);
  const choosing = item.type === "ambiguous" || item.type === "near_miss";

  return (
    <section className="flex flex-col gap-2.5 border-b border-line-soft px-4 py-4 last:border-b-0 sm:px-5" data-testid="review-item" data-type={item.type}>
      <div className="flex items-start gap-3">
        {selecting && (
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
            aria-label={s.selectItem}
            disabled={BULK[item.type].length === 0}
            className="hit relative mt-1 size-4 shrink-0 cursor-pointer accent-[var(--brand)]"
          />
        )}
        <div className="flex min-w-0 flex-col gap-0.5 md:flex-row md:flex-wrap md:items-baseline md:gap-x-2.5">
          <h3 className="text-body font-semibold">{title}</h3>
          <p className="text-meta text-2">{summary.join(" · ")}</p>
        </div>
      </div>

      {choosing && (
        <div role="radiogroup" aria-label={s.candidates} className="flex flex-col gap-1">
          {item.candidates.map((x) => (
            <Candidate key={x.transactionId} x={x} hold={c.hold} on={pick === x.transactionId} onPick={() => setPick(x.transactionId)} />
          ))}
        </div>
      )}
      {item.type === "stale" && <p className="text-meta text-2">{s.staleHint}</p>}
      {item.type === "amount_changed" && item.shares && (
        <p className="text-meta text-2">
          {fmt(s.sharesHint, { shares: moneyText(item.shares.sharesMinor, c.currency), amount: moneyText(item.shares.amountMinor, c.currency) })}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {item.type === "ambiguous" && (
          <>
            <Button size="sm" disabled={busy} onClick={() => onAct("keep_separate")}>
              {s.actions.keepSeparate}
            </Button>
            <Button size="sm" variant="primary" disabled={busy || pick == null} onClick={() => onAct("link", pick ?? undefined)}>
              {s.actions.link}
            </Button>
          </>
        )}
        {item.type === "near_miss" && (
          <>
            <Button size="sm" disabled={busy} onClick={() => onAct("keep_separate")}>
              {s.actions.keepBoth}
            </Button>
            <Button size="sm" variant="primary" disabled={busy || pick == null} onClick={() => onAct("link", pick ?? undefined)}>
              {s.actions.sameCharge}
            </Button>
          </>
        )}
        {item.type === "stale" && (
          <>
            <Button size="sm" disabled={busy} onClick={() => onAct("discard")}>
              {s.actions.discard}
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onAct("keep_final")}>
              {s.actions.keepFinal}
            </Button>
          </>
        )}
        {item.type === "amount_changed" && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onAct("keep_shares")}>
            {s.actions.keepShares}
          </Button>
        )}
      </div>
    </section>
  );
}

/** A statement row offered for the capture: radio, "ICBC credit card · UBER EATS · Oct 2 · $28.79", reason chips. */
function Candidate({ x, hold, on, onPick }: { x: MatchCandidate; hold: boolean; on: boolean; onPick: () => void }) {
  const t = useT();
  const s = t.capture.sheet;
  const locale = useLocale();
  const chips = [
    x.reasons.includes("amount") ? s.reasons.amount : hold ? fmt(s.tip, { amount: `+${moneyText(x.amountDiffMinor, x.currency)}` }) : null,
    x.reasons.includes("card") ? s.reasons.card : null,
    x.reasons.includes("merchant") ? s.reasons.merchant : null,
    dayShift(s, x.daysAfter),
  ].filter((v): v is string => v != null);
  return (
    <label className={cn("flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-2.5 py-2", on ? "bg-sunken" : "hover:bg-sunken/60")}>
      <input type="radio" checked={on} onChange={onPick} aria-label={s.pick} className="size-3.5 shrink-0 cursor-pointer accent-[var(--brand)]" />
      <span className="min-w-0 flex-1 basis-40 truncate">
        {[t.transactions.sources[x.source as keyof typeof t.transactions.sources] ?? x.source, x.merchant, dayLabel(x.occurredOn, locale)].filter(Boolean).join(" · ")}
      </span>
      <Money minor={Math.abs(x.amountMinor)} currency={x.currency} className="shrink-0" />
      <span className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <span key={chip} className="rounded-full bg-tile px-2 py-0.5 text-hint text-2">
            {chip}
          </span>
        ))}
      </span>
    </label>
  );
}
