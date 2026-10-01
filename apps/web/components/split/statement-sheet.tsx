"use client";

import type { Balance, Locale, SharedNote, Statement, StatementEntry, StatementFlag, StatementScope } from "@yomi/contracts";
import { CheckIcon, ChevronDownIcon, CopyIcon, MessageSquareTextIcon, SlidersHorizontalIcon, StickyNoteIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { CsvLink } from "@/components/csv-link";
import { Money, moneyText } from "@/components/money";
import { HowToPay } from "@/components/payment/how-to-pay";
import { Segmented } from "@/components/ui-kit/segmented";
import { Switch } from "@/components/ui-kit/switch";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { errorText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { dayLabel } from "@/lib/month";
import { categoryLabel } from "@/i18n/categories";
import { cn } from "@/lib/utils";
import { PrintPreviewLink } from "./print-button";
import { MonthChecklist } from "./settle-all-sheet";
import {
  type SharedMode,
  colorsQuery,
  loadFlags,
  loadOptionsOpen,
  loadWhitePaper,
  rowSplitLabel,
  saveFlags,
  saveOptionsOpen,
  saveWhitePaper,
  sharedMode,
  showQuery,
  toggleFlag,
  withSharedMode,
} from "./statement-scope";
import { Sheet } from "./ui";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

const STATEMENT_LOCALES: Locale[] = ["en", "zh-CN"];

/** Inline editor for the shared note on an item ("Note for Alex"): Enter saves, Esc cancels. */
function NoteForm({ entry, name, onDone }: { entry: StatementEntry; name: string; onDone: (saved: boolean) => void }) {
  const t = useT();
  const st = t.split.statement;
  const [value, setValue] = useState(entry.sharedNote ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await apiFetch<SharedNote>(`/transactions/${entry.transactionId}/shared-note`, { method: "PUT", json: { sharedNote: value.trim() || null } });
      toast.success(t.aa.sharedNoteSaved);
      onDone(true);
    } catch {
      // apiFetch toasted
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-1.5 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        autoFocus
        value={value}
        maxLength={500}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone(false);
          }
        }}
        aria-label={fmt(st.noteFor, { name })}
        placeholder={t.aa.sharedNotePlaceholder}
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-meta outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25"
      />
      <Button type="submit" variant="soft" size="sm" disabled={busy}>
        {st.noteSave}
      </Button>
    </form>
  );
}

/**
 * One item: checkbox · merchant · their share (the main number); under it "Jul 4 · Split 3 ways" with the note button
 * at the end, and the shared note as a quiet line.
 */
function ItemRow({
  it,
  check,
  s,
  flags,
  onChanged,
}: {
  it: StatementEntry;
  check: ReactNode;
  s: Statement;
  flags: readonly StatementFlag[];
  onChanged: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const st = t.split.statement;
  const c = s.currency;
  const name = s.participantName;
  const [editing, setEditing] = useState(false);
  const covered = it.status === "covered";
  const meta = [
    dayLabel(it.date, locale),
    rowSplitLabel(st, t.split.print, it, flags),
    it.paidByThem ? fmt(st.theyPaid, { name }) : "",
    flags.includes("myshare")
      ? fmt(s.myName ? st.nameShare : st.myShare, { amount: moneyText(it.myShareMinor, c), name: s.myName ?? "" })
      : "",
    flags.includes("category") && it.category ? categoryLabel(it.category, t) : "",
    it.status === "partial" ? fmt(st.left, { amount: moneyText(Math.abs(it.remainingMinor), c) }) : "",
    covered && it.settledOn ? fmt(st.settledOn, { date: dayLabel(it.settledOn, locale) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const noteLabel = fmt(it.sharedNote ? st.editNote : st.addNote, { name });
  return (
    <div className="flex gap-3 border-b border-line-soft px-3 py-2.5">
      <span className="flex h-[22px] items-center">{check}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span className={cn("min-w-0 flex-1 truncate text-body", covered && "text-2")}>{it.merchant || t.common.noName}</span>
          <Money
            minor={it.paidByThem ? it.deltaMinor : it.theirShareMinor}
            currency={c}
            className={cn("shrink-0 text-body font-medium", covered && "text-2")}
          />
        </div>
        <div className="flex min-h-6 items-center gap-1">
          <span className="min-w-0 truncate text-meta text-2">{meta}</span>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-label={noteLabel}
            title={noteLabel}
            aria-expanded={editing}
            className="hit relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-3 transition-colors duration-[120ms] hover:bg-tile hover:text-foreground"
          >
            <StickyNoteIcon className="size-3.5" aria-hidden />
          </button>
        </div>
        {it.sharedNote && !editing && (
          <p className="text-meta break-words text-2">
            <MessageSquareTextIcon className="mr-1 inline size-3.5 align-[-2px] text-3" aria-hidden />
            {it.sharedNote}
          </p>
        )}
        {editing && (
          <NoteForm
            entry={it}
            name={name}
            onDone={(saved) => {
              setEditing(false);
              if (saved) onChanged();
            }}
          />
        )}
      </div>
    </div>
  );
}

type Base = Exclude<StatementScope, "selected">;

/** The items a scope covers, from the statement's full item list. */
function scopeEntries(s: Statement, base: Base, selected: ReadonlySet<number>): StatementEntry[] {
  if (selected.size > 0) return s.entries.filter((e) => selected.has(e.transactionId));
  return base === "all" ? s.entries : s.entries.filter((e) => e.status !== "covered");
}

function ItemsView({
  s,
  flags,
  base,
  selected,
  onSelect,
  onChanged,
}: {
  s: Statement;
  flags: readonly StatementFlag[];
  base: Base;
  selected: ReadonlySet<number>;
  onSelect: (next: Set<number>) => void;
  onChanged: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const st = t.split.statement;
  const c = s.currency;
  const listed = base === "all" ? s.entries : s.entries.filter((e) => e.status !== "covered");
  return (
    <div data-testid="statement-items">
      {listed.length === 0 && s.openOpeningMinor === 0 && s.unmatchedMinor === 0 ? (
        <p className="px-3 py-4 text-body text-2">{st.nothingOpen}</p>
      ) : (
        <>
          <MonthChecklist
            items={listed}
            selected={selected}
            onChange={onSelect}
            testId="statement-checklist"
            itemLabel={(it) => fmt(st.selectItem, { item: `${dayLabel(it.date, locale)} ${it.merchant || t.common.noName}` })}
            row={(it, check) => <ItemRow it={it} check={check} s={s} flags={flags} onChanged={onChanged} />}
          />
          {s.openOpeningMinor !== 0 && (
            <p className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5 text-body">
              <span className="flex-1">{st.openingLine}</span>
              <Money minor={s.openOpeningMinor} currency={c} className="font-medium" />
            </p>
          )}
          {s.unmatchedMinor !== 0 && (
            <p className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5 text-body">
              <span className="flex-1">{st.paidAhead}</span>
              <Money minor={s.unmatchedMinor} currency={c} className="font-medium" />
            </p>
          )}
        </>
      )}
      {flags.includes("settlements") && s.recentSettlements.length > 0 && (
        <section aria-label={st.recentTitle}>
          <h3 className="flex h-9 items-center border-b border-line-soft bg-raised px-3 text-meta font-medium text-2">{st.recentTitle}</h3>
          <ul>
            {s.recentSettlements.map((r) => (
              <li key={r.settlementId} className="flex flex-col gap-1 border-b border-line-soft px-3 py-2.5">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-body">
                    {fmt(r.amountMinor > 0 ? t.split.print.toMe : t.split.print.toThem, { name: s.participantName })}
                  </span>
                  <Money minor={Math.abs(r.amountMinor)} currency={c} className="shrink-0 text-body font-medium" />
                </div>
                <p className="text-meta text-2">
                  {dayLabel(r.date, locale)}
                  {r.originalAmountMinor !== null && r.originalCurrency && r.fxRate
                    ? ` · ${fmt(t.split.print.actually, { amount: moneyText(Math.abs(r.originalAmountMinor), r.originalCurrency), rate: r.fxRate })}`
                    : ""}
                  {r.note ? ` · ${r.note}` : ""}
                </p>
                {r.items.length > 0 && (
                  <ul className="mt-0.5 flex flex-col gap-0.5 border-l-2 border-line-soft pl-3">
                    {r.items.map((it) => (
                      <li key={it.transactionId} className="flex items-center gap-2 text-meta text-2">
                        <span className="min-w-0 flex-1 truncate">
                          {dayLabel(it.date, locale)} · {it.merchant || t.common.noName}
                        </span>
                        <Money minor={it.paidMinor} currency={c} className="shrink-0" />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <HowToPay methods={s.payment} t={t} currency={s.currency} variant="sheet" />
    </div>
  );
}

/** The collapsible Options panel: who shared (count, names, hidden) and five switches, each with a short help line. */
function OptionsPanel({
  flags,
  name,
  onChange,
  csvHref,
  whitePaper,
  onWhitePaper,
}: {
  flags: StatementFlag[];
  name: string;
  onChange: (next: StatementFlag[]) => void;
  csvHref: string;
  /** "Print on white paper" instead of the screen colors; remembered per person beside the flags. */
  whitePaper: boolean;
  onWhitePaper: (next: boolean) => void;
}) {
  const t = useT();
  const st = t.split.statement;
  const [open, setOpen] = useState(loadOptionsOpen);
  const mode = sharedMode(flags);
  const modeLabel: Record<SharedMode, string> = { count: st.sharedCount, names: st.sharedNames, hidden: st.sharedHidden };
  const switches: { flag: StatementFlag; label: string; help: string }[] = [
    { flag: "myshare", label: st.optMyShare, help: st.optMyShareHelp },
    { flag: "notes", label: st.optNotes, help: fmt(st.optNotesHelp, { name }) },
    { flag: "settlements", label: st.optSettlements, help: st.optSettlementsHelp },
    { flag: "category", label: st.optCategory, help: st.optCategoryHelp },
    { flag: "payment", label: st.optPayment, help: st.optPaymentHelp },
  ];
  const summary = [
    fmt(st.whoSharedSummary, { value: modeLabel[mode] }),
    ...switches.filter((s) => flags.includes(s.flag)).map((s) => s.label),
    whitePaper ? st.optWhitePaper : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div data-testid="statement-options">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="statement-options-panel"
        onClick={() => {
          setOpen(!open);
          saveOptionsOpen(!open);
        }}
        className="hit relative -mx-1.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-meta text-2 transition-colors duration-[120ms] hover:text-foreground"
      >
        <SlidersHorizontalIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium text-foreground">{st.options}</span>
        {!open && <span className="min-w-0 truncate">{summary}</span>}
        <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform duration-[120ms]", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div id="statement-options-panel" className="mt-2 rounded-lg border border-border bg-surface px-4 py-3">
          <p className="mb-2 text-meta text-2">{st.optionsHint}</p>
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 py-1.5 sm:col-span-2">
              <span className="flex flex-col">
                <span className="text-body">{st.whoShared}</span>
                <span className="text-meta text-2">{st.whoSharedHelp}</span>
              </span>
              <Segmented
                label={st.whoShared}
                value={mode}
                onChange={(m) => onChange(withSharedMode(flags, m))}
                options={(["count", "names", "hidden"] as const).map((m) => ({ value: m, label: modeLabel[m] }))}
              />
            </div>
            {switches.map((s) => (
              <Switch key={s.flag} label={s.label} help={s.help} checked={flags.includes(s.flag)} onChange={() => onChange(toggleFlag(flags, s.flag))} />
            ))}
            <Switch label={st.optWhitePaper} help={st.optWhitePaperHelp} checked={whitePaper} onChange={onWhitePaper} />
          </div>
          <div className="mt-2 border-t border-line-soft pt-2">
            <CsvLink href={csvHref} className="-mx-1.5" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The statement for one person: items (with their shared notes, editable here) and recent settlements, or the
 * plain text written to them for pasting into WeChat, in the language picked here (default: the UI language). The
 * scope (open items, all items, or the ticked ones) applies to the text, the PDF, the CSV and "Settle these". The
 * options apply to all outputs as `show=` and are remembered per person in localStorage. Header and controls stay put,
 * the list scrolls, and the footer (totals, Copy text, Print preview, Settle these) is pinned to the bottom.
 */
export function StatementSheet({
  participantId,
  name,
  lines,
  onSettle,
  refreshKey = 0,
}: {
  participantId: number;
  name: string;
  lines: Balance[];
  /** "Settle these": the open items in scope, in the statement's currency. */
  onSettle?: (currency: string, transactionIds: number[]) => void;
  /** Bump after a settlement made on top of the statement: reloads the items and clears the selection. */
  refreshKey?: number;
}) {
  const t = useT();
  const uiLocale = useLocale();
  const st = t.split.statement;
  const firstOpen = lines.find((l) => l.owedToMeMinor !== 0) ?? lines[0];
  const [cur, setCur] = useState(firstOpen?.currency ?? "CNY");
  const [lang, setLang] = useState<Locale>(uiLocale);
  const [view, setView] = useState<"items" | "text">("items");
  const [base, setBase] = useState<Base>("open");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [flags, setFlags] = useState<StatementFlag[]>(() => loadFlags(participantId));
  const [whitePaper, setWhitePaper] = useState(() => loadWhitePaper(participantId));
  const [version, setVersion] = useState(0);
  const [seenRefresh, setSeenRefresh] = useState(refreshKey);
  const [data, setData] = useState<{ key: string; statement: Statement | null; error?: string } | null>(null);
  if (seenRefresh !== refreshKey) {
    setSeenRefresh(refreshKey);
    setSelected(new Set());
  }
  const scope: StatementScope = selected.size > 0 ? "selected" : base;
  const scopeQuery =
    scope === "selected" ? `&scope=selected&items=${[...selected].sort((a, b) => a - b).join(",")}` : scope === "all" ? "&scope=all" : "";
  const prefix = `${participantId}|${cur}|${lang}|`;
  const key = `${prefix}${version}|${refreshKey}|${scopeQuery}|${showQuery(flags)}`;
  const query = `participantId=${participantId}&currency=${cur}&locale=${encodeURIComponent(lang)}${scopeQuery}${showQuery(flags)}`;

  useEffect(() => {
    let live = true;
    apiFetch<Statement>(`/split/statement?${query}`, { silent: true })
      .then((s) => live && setData({ key, statement: s }))
      .catch((e: Error) => live && setData({ key, statement: null, error: errorText(e, t) }));
    return () => {
      live = false;
    };
  }, [query, key, t]);

  const current = data?.key === key ? data : null;
  // Keep showing the last statement while a note save or a new scope reloads it.
  const shown = current ?? (data?.key.startsWith(prefix) ? data : null);
  const text = current?.statement?.text ?? "";
  const s = shown?.statement ?? null;
  const inScope = useMemo(() => (s ? scopeEntries(s, base, selected) : []), [s, base, selected]);
  const toSettle = inScope.filter((e) => e.status !== "covered").map((e) => e.transactionId);
  const openSum = inScope.reduce((sum, e) => sum + e.remainingMinor, 0);
  const totalSum = inScope.reduce((sum, e) => sum + e.deltaMinor, 0);

  const setPaper = (next: boolean) => {
    setWhitePaper(next);
    saveWhitePaper(participantId, next);
  };
  const setOptions = (next: StatementFlag[]) => {
    setFlags(next);
    saveFlags(participantId, next);
  };
  const pickScope = (v: StatementScope) => {
    if (v === "selected") return;
    setBase(v);
    setSelected(new Set());
  };
  const copy = async () => {
    if (await copyText(text)) toast.success(st.copied);
    else toast.error(st.copyFailed);
  };
  const canSettle = view === "items" && Boolean(onSettle);

  const footer = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className="num min-w-0 flex-1 text-meta text-2 max-sm:basis-full" data-testid="statement-footer-totals">
        {s ? plural(st.footerTotals, inScope.length, { open: moneyText(openSum, cur) }) : " "}
      </p>
      <div className="flex items-center gap-2 max-sm:grid max-sm:w-full max-sm:grid-cols-2">
        <Button variant={view === "text" ? "primary" : "outline"} disabled={!text} onClick={() => void copy()}>
          <CopyIcon aria-hidden />
          {st.copy}
        </Button>
        <PrintPreviewLink href={`/split/statement/print?${query}${colorsQuery(whitePaper)}`} label={st.printPreview} />
        {canSettle && (
          <Button
            variant="primary"
            className="max-sm:order-first max-sm:col-span-2"
            disabled={toSettle.length === 0}
            title={toSettle.length === 0 ? st.settleNone : undefined}
            onClick={() => onSettle?.(cur, toSettle)}
          >
            <CheckIcon aria-hidden />
            {st.settleThese}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Sheet title={fmt(st.title, { name })} description={st.description} size="lg" footer={footer}>
      <div className="flex shrink-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label={st.view}
              value={view}
              onChange={setView}
              options={[
                { value: "items", label: st.viewItems },
                { value: "text", label: st.viewText },
              ]}
            />
            {lines.length > 1 && (
              <Segmented
                label={t.common.currency}
                value={cur}
                onChange={(v) => {
                  setCur(v);
                  setSelected(new Set());
                }}
                options={lines.map((l) => ({ value: l.currency, label: l.currency }))}
              />
            )}
          </div>
          <Segmented
            label={st.language}
            value={lang}
            onChange={setLang}
            options={STATEMENT_LOCALES.map((l) => ({ value: l, label: st.languages[l], lang: l }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Segmented
            label={st.scope}
            value={scope}
            onChange={pickScope}
            options={[
              { value: "open", label: st.scopeOpen },
              { value: "all", label: st.scopeAll },
              { value: "selected", label: selected.size > 0 ? `${st.scopeSelected} (${selected.size})` : st.scopeSelected },
            ]}
          />
          {s && (
            <span className="num text-meta text-2" data-testid="statement-scope-totals">
              {fmt(st.scopeTotal, { currency: cur, total: moneyText(totalSum, cur) })}
            </span>
          )}
        </div>
        <OptionsPanel
          flags={flags}
          name={name}
          onChange={setOptions}
          csvHref={`/api/export/split.csv?${query}`}
          whitePaper={whitePaper}
          onWhitePaper={setPaper}
        />
      </div>
      <div
        className={cn(
          "mt-3 mb-4 min-h-48 flex-1 overflow-y-auto rounded-lg border border-border",
          view === "text" && "bg-sunken px-4 py-3 text-body leading-[22px] whitespace-pre-wrap break-words",
        )}
        aria-live="polite"
        aria-busy={!current}
      >
        {!shown ? (
          <p className={cn("text-3", view === "items" && "px-3 py-4")}>{st.generating}</p>
        ) : shown.error || !s ? (
          <p className={cn(view === "items" && "px-3 py-4")}>{shown.error}</p>
        ) : view === "text" ? (
          (current?.statement?.text ?? s.text)
        ) : (
          <ItemsView s={s} flags={flags} base={base} selected={selected} onSelect={setSelected} onChanged={() => setVersion((v) => v + 1)} />
        )}
      </div>
    </Sheet>
  );
}
