"use client";

import type { Participant, ParticipantList, QuickCreated, QuickDraft, QuickSms } from "@yomi/contracts";
import { formatMinor, splitEqual } from "@yomi/core/money";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CategoryPill } from "@/components/category-pill";
import { Money } from "@/components/money";
import { ParticipantChip } from "@/components/participant-chip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import type { Dictionary } from "@/i18n/en";
import { errorText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { dayLabel, todayLocal } from "@/lib/month";
import { QUICK_ADD_EVENT } from "@/lib/quick-add";
import { localTimeOf, useTimeZone } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

const PARSE_DELAY_MS = 150;

type Draft = QuickDraft & { text: string };

async function parse(text: string): Promise<Draft> {
  const draft = await apiFetch<QuickDraft>("/quick/parse", { json: { text, today: todayLocal() }, silent: true });
  return { ...draft, text };
}

/** "ICBC card ····3141 · Sep 27 08:24 · BUSY BEE BOBA · $15.74" for a pasted card alert. */
function SmsLine({ sms, t, locale }: { sms: QuickSms; t: Dictionary; locale: ReturnType<typeof useLocale> }) {
  const timeZone = useTimeZone();
  const kind = sms.hold ? t.capture.hold : t.quickAdd.sms.kinds[sms.kind];
  const parts = [
    fmt(t.quickAdd.sms.card, { last4: sms.last4 }),
    `${dayLabel(sms.occurredOn, locale)} ${localTimeOf({ occurredAt: sms.occurredAt, source: "sms" }, timeZone)}`,
    sms.merchant,
    kind,
  ].filter(Boolean);
  return (
    <p className="text-body" data-testid="quick-sms">
      {parts.join(" · ")}
      {" · "}
      <Money
        minor={Math.abs(sms.amountMinor)}
        currency={sms.currency}
        sign={sms.amountMinor > 0 ? "inflow" : "plain"}
        className="font-medium"
        showCode={sms.currency !== "USD" && sms.currency !== "CNY"}
      />
    </p>
  );
}

function shareLine(draft: QuickDraft, selfId: number | undefined, t: Dictionary): string | null {
  const others = draft.participantIds.filter((id) => id !== selfId);
  if (others.length === 0 || draft.amountMinor === null) return null;
  if (draft.mode === "full") return t.quickAdd.fullOther;
  if (draft.mode !== "equal") return null;
  const shares = splitEqual(draft.amountMinor, others.length + 1);
  const each = shares[shares.length - 1] ?? 0;
  const mine = shares[0] ?? 0;
  return mine === each
    ? fmt(t.quickAdd.each, { amount: formatMinor(each, draft.currency) })
    : fmt(t.quickAdd.youAndOthers, { mine: formatMinor(mine, draft.currency), each: formatMinor(each, draft.currency) });
}

/** Global quick-add palette. Mounted once in the root layout; open it with openQuickAdd() or ⌘K / "/". */
export function QuickAdd() {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const q = t.quickAdd;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const loadParticipants = useCallback(async () => {
    try {
      const res = await apiFetch<ParticipantList>("/participants", { silent: true });
      setParticipants(res.participants);
    } catch {
      /* the preview falls back to ids */
    }
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const prefill = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (prefill !== undefined) setText(prefill);
      setOpen(true);
      void loadParticipants();
    };
    window.addEventListener(QUICK_ADD_EVENT, onOpen);
    return () => window.removeEventListener(QUICK_ADD_EVENT, onOpen);
  }, [loadParticipants]);

  const runParse = useCallback(async (value: string): Promise<Draft | null> => {
    const id = ++seq.current;
    if (!value.trim()) {
      setDraft(null);
      setParsing(false);
      return null;
    }
    setParsing(true);
    try {
      const d = await parse(value);
      if (id === seq.current) setDraft(d);
      return d;
    } catch {
      return null;
    } finally {
      if (id === seq.current) setParsing(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void runParse(text), text.trim() ? PARSE_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [text, open, runParse]);

  const self = participants.find((p) => p.isSelf);
  const nameOf = (id: number) => {
    const p = participants.find((x) => x.id === id);
    return p ? (p.isSelf ? t.common.me : p.name) : `#${id}`;
  };

  async function save() {
    if (saving || !text.trim()) return;
    const d = draft && draft.text === text ? draft : await runParse(text);
    if (!d || d.errors.length > 0 || d.amountMinor === null) {
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const { text: _text, errors: _errors, sms, ...body } = d;
      const res = await apiFetch<QuickCreated>("/quick", { json: sms ? { ...body, smsText: d.text, today: todayLocal() } : body });
      const amount = formatMinor(d.amountMinor, d.currency);
      if (res.alreadyAdded) toast(q.sms.already, { description: d.description || undefined });
      else if (res.duplicateOfId != null) toast.success(q.sms.linked, { description: d.description || undefined });
      else if (res.review) toast.success(fmt(q.sms.toReview, { amount }), { description: d.description || undefined });
      else if (sms?.hold) toast.success(fmt(q.sms.holdSaved, { amount }), { description: d.description || undefined });
      else toast.success(fmt(sms ? q.sms.saved : q.saved, { amount }), { description: d.description || undefined });
      setText("");
      setDraft(null);
      router.refresh();
    } catch {
      /* apiFetch already toasted the server message */
    } finally {
      setSaving(false);
      inputRef.current?.focus();
    }
  }

  async function createParticipant(name: string) {
    setCreating(name);
    try {
      await apiFetch("/participants", { json: { name } });
      await loadParticipants();
      await runParse(text);
      router.refresh();
    } catch {
      /* toasted */
    } finally {
      setCreating(null);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void save();
  }

  const current = draft;
  const errors = current?.errors ?? [];
  const share = current ? shareLine(current, self?.id, t) : null;
  const others = current ? current.participantIds.filter((id) => id !== self?.id) : [];
  const canSave = !!current && current.text === text && errors.length === 0 && current.amountMinor !== null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden rounded-lg bg-surface p-0 shadow-dialog ring-border sm:max-w-[560px] data-open:zoom-in-100 data-closed:zoom-out-100"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">{q.title}</DialogTitle>
        <DialogDescription className="sr-only">{q.description}</DialogDescription>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={q.placeholder}
            aria-label={q.title}
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-title outline-none placeholder:text-3"
          />
          {(parsing || saving) && <Loader2Icon className="size-4 animate-spin text-3" aria-hidden />}
        </div>

        <div className="min-h-[76px] px-4 py-3" aria-live="polite">
          {!current || !text.trim() ? (
            <div className="space-y-2">
              <p className="text-meta text-3">{q.tryThese}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {q.examples.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => {
                      setText(ex);
                      inputRef.current?.focus();
                    }}
                    className="text-body text-2 transition-colors duration-[120ms] hover:text-foreground"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className={cn("space-y-2 transition-opacity duration-[120ms]", current.text !== text && "opacity-60")}>
              {current.sms ? (
                <SmsLine sms={current.sms} t={t} locale={locale} />
              ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-body">
                <span className={cn("min-w-0 truncate", !current.description && "text-3")}>
                  {current.description || q.noDescription}
                </span>
                <span className="text-3">|</span>
                {current.amountMinor !== null ? (
                  <Money minor={current.amountMinor} currency={current.currency} className="font-medium" showCode={current.currency !== "CNY"} />
                ) : (
                  <span className="text-3">{q.noAmount}</span>
                )}
                <span className="text-3">|</span>
                <span className="text-2">{dayLabel(current.date, locale, { relative: true })}</span>
                {current.categoryHint && <CategoryPill name={current.categoryHint} />}
              </div>
              )}

              {(others.length > 0 || current.payerId !== null) && (
                <div className="flex flex-wrap items-center gap-1.5 text-meta text-2">
                  <span>{current.payerId !== null ? q.friendPaidSplit : q.split}</span>
                  {current.payerId !== null && !others.includes(current.payerId) && (
                    <ParticipantChip label={nameOf(current.payerId)} state="payer" tabIndex={-1} />
                  )}
                  {others.map((id) => (
                    <ParticipantChip
                      key={id}
                      label={nameOf(id)}
                      state={id === current.payerId ? "payer" : "on"}
                      tabIndex={-1}
                    />
                  ))}
                  {share && <span className="ml-1">{share}</span>}
                </div>
              )}

              {errors.length > 0 && (
                <ul className="space-y-1 text-meta text-2">
                  {errors.map((err, i) => (
                    <li key={`${err.code}-${i}`} className="flex flex-wrap items-center gap-2">
                      <span>{errorText(err, t)}</span>
                      {err.code === "quick_unknown_participant" && err.name && (
                        <button
                          type="button"
                          disabled={creating !== null}
                          onClick={() => void createParticipant(err.name!)}
                          className="rounded-full border border-dashed border-primary/60 px-2 text-primary transition-colors duration-[120ms] hover:bg-primary-soft disabled:opacity-50"
                        >
                          {fmt(q.createPerson, { name: err.name })}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border bg-sunken/60 px-4 py-2 text-meta text-2">
          <span>{q.grammar}</span>
          <span className={cn("hidden shrink-0 whitespace-nowrap md:inline", canSave && "text-foreground")}>
            <kbd className="rounded-sm border border-border bg-surface px-1">↵</kbd> {q.save}
            <kbd className="ml-3 rounded-sm border border-border bg-surface px-1">Esc</kbd> {q.close}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
