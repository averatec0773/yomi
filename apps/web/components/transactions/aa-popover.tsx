"use client";

import { formatMinor, minorDigits, parseAmountToMinor, splitEqual } from "@yomi/core/money";
import type { SharedNote } from "@yomi/contracts";
import { CheckIcon, MessageSquareTextIcon, PlusIcon, UsersIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { Money } from "@/components/money";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmt, plural } from "@/i18n";
import { useT } from "@/i18n/client";
import { sourceTermLabel } from "@/i18n/source-terms";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { canSplit, type SplitMode, splitStateOf } from "./split-math";
import { suggestionReason } from "./suggestion";
import type { Participant, RowActions, Tx } from "./types";

const MODES: SplitMode[] = ["equal", "exact", "full"];

function toInput(minor: number, currency: string): string {
  const d = minorDigits(currency);
  return d === 0 ? String(minor) : (minor / 10 ** d).toFixed(d);
}

function parse(v: string, currency: string): number | null {
  if (!v.trim()) return 0;
  try {
    const n = parseAmountToMinor(v, minorDigits(currency));
    return n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function isTextInput(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement && t.type !== "checkbox";
}

/** One checkbox line: me or a participant, with its 1-9 key and the share on the right. */
function PersonLine({
  name,
  checked,
  disabled,
  keyHint,
  onToggle,
  right,
  note,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  keyHint?: number;
  onToggle?: () => void;
  right?: ReactNode;
  note?: string;
}) {
  return (
    <li className="flex h-9 items-center gap-2.5">
      <label className={cn("flex min-w-0 flex-1 items-center gap-2.5", disabled ? "cursor-default" : "cursor-pointer")}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle?.()}
          aria-label={name}
          className="size-4 shrink-0 accent-[var(--brand)] disabled:opacity-60"
        />
        <span className={cn("truncate text-body", (disabled || !checked) && "text-2", disabled && !checked && "text-3")}>{name}</span>
        {note && <span className="shrink-0 text-hint text-3">{note}</span>}
      </label>
      {right}
      {keyHint !== undefined && (
        <kbd className="w-4 shrink-0 text-center font-num text-hint text-3" aria-hidden>
          {keyHint}
        </kbd>
      )}
    </li>
  );
}

/** "+ Add person": inline input; Enter creates the participant and hands it back checked. */
function AddPerson({ onAdd }: { onAdd: (name: string) => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="hit relative inline-flex h-9 items-center gap-2 text-body text-primary transition-opacity duration-[120ms] hover:opacity-80"
      >
        <PlusIcon className="size-3.5" aria-hidden />
        {t.aa.addPerson}
      </button>
    );
  }
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await onAdd(n);
      setName("");
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-9 items-center gap-2">
      <input
        autoFocus
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        placeholder={t.aa.addPlaceholder}
        aria-label={t.aa.addLabel}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-body outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !name.trim()}
        className="h-7 rounded-md px-2 text-body text-primary hover:bg-primary-soft disabled:opacity-40"
      >
        {t.common.add}
      </button>
    </div>
  );
}

function ModeSwitch({ value, onChange, disabled }: { value: SplitMode; onChange: (m: SplitMode) => void; disabled: (m: SplitMode) => boolean }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t.aa.modeLabel} className="grid grid-cols-3 gap-1 rounded-[10px] bg-background p-[3px]">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          disabled={disabled(m)}
          onClick={() => onChange(m)}
          className={cn(
            "h-[30px] min-w-0 truncate rounded-lg px-2 text-meta whitespace-nowrap transition-colors duration-[120ms] disabled:opacity-40",
            value === m ? "bg-border font-medium text-foreground" : "text-2 hover:text-foreground",
          )}
        >
          {t.aa.modes[m]}
        </button>
      ))}
    </div>
  );
}

/**
 * "Note for Alex": the row's note for the people it is shared with (their statement shows it). Loaded when the
 * popover opens; saved on Enter or when the field loses focus. The private note is separate.
 */
function SharedNoteField({ txId, names }: { txId: number; names: string }) {
  const t = useT();
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    let live = true;
    apiFetch<SharedNote>(`/transactions/${txId}/shared-note`, { silent: true })
      .then((r) => {
        if (!live) return;
        setSaved(r.sharedNote ?? "");
        setValue(r.sharedNote ?? "");
      })
      .catch(() => live && setSaved(""));
    return () => {
      live = false;
    };
  }, [txId]);
  const save = async () => {
    const next = value.trim();
    if (saved === null || next === saved) return;
    try {
      const r = await apiFetch<SharedNote>(`/transactions/${txId}/shared-note`, { method: "PUT", json: { sharedNote: next || null } });
      setSaved(r.sharedNote ?? "");
      toast.success(t.aa.sharedNoteSaved);
    } catch {
      // apiFetch toasted
    }
  };
  const label = fmt(t.aa.sharedNote, { name: names });
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-meta text-2">
        <MessageSquareTextIcon className="size-3.5 text-3" aria-hidden />
        {label}
      </span>
      <input
        value={value}
        disabled={saved === null}
        maxLength={500}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
        placeholder={t.aa.sharedNotePlaceholder}
        aria-label={label}
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-meta outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-50"
      />
    </label>
  );
}

const footerDanger = "hit relative h-8 text-meta text-2 transition-colors duration-[120ms] hover:text-foreground";

/** Single row: every change applies right away (optimistic), except By amount which saves on its button. */
function RowPanel({
  tx,
  others,
  selfId,
  nameOf,
  autoSplit,
  actions,
}: {
  tx: Tx;
  others: Participant[];
  selfId: number;
  nameOf: (id: number) => string;
  autoSplit: boolean;
  actions: RowActions;
}) {
  const t = useT();
  const current = splitStateOf(tx, selfId);
  const total = Math.abs(tx.amountMinor);
  const payerId = current?.payerId ?? selfId;
  const friendPaid = payerId !== selfId;
  const serverIds = current?.participantIds ?? [];
  const [mode, setModeState] = useState<SplitMode>(current?.mode ?? "equal");
  const [exactIds, setExactIds] = useState<number[]>([]);
  const [exact, setExact] = useState<Record<number, string>>({});
  const [auto, setAuto] = useState(autoSplit);

  const owedOf = (id: number) => tx.splits.find((s) => s.participantId === id)?.owedMinor ?? 0;
  // Friend paid: the payer always stays in (the row only records me and them).
  const checkedIds = mode === "exact" ? exactIds : friendPaid ? [...new Set([payerId, ...serverIds])] : serverIds;

  let exactSum = 0;
  let invalid: string | null = null;
  if (mode === "exact") {
    for (const id of exactIds) {
      const v = parse(exact[id] ?? "", tx.currency);
      if (v === null) invalid = fmt(t.aa.invalidAmount, { name: nameOf(id) });
      exactSum += v ?? 0;
    }
    if (exactSum > total) invalid = fmt(t.aa.overTotal, { amount: formatMinor(exactSum - total, tx.currency) });
  }
  const myShare = mode === "exact" ? total - exactSum : tx.splits.length ? owedOf(selfId) : total;

  const canAuto = Boolean(tx.merchant) && !friendPaid && tx.accountId !== null;
  const reason = !current && tx.suggestion ? suggestionReason(tx.suggestion, t, nameOf) : null;
  const autoAllowed = current?.mode === "equal" && serverIds.length > 0;

  const syncAuto = (ids: number[]) => {
    if (!auto || !canAuto) return;
    if (ids.length === 0) {
      setAuto(false);
      actions.setAutoSplit(tx.id, false, [], true);
    } else actions.setAutoSplit(tx.id, true, ids, true);
  };

  const enterExact = (ids: number[]) => {
    const group = friendPaid ? [payerId] : ids;
    const values: Record<number, string> = {};
    const equal = splitEqual(total, group.length + 1);
    group.forEach((id, i) => {
      values[id] = toInput(tx.splits.length ? owedOf(id) : (equal[i + 1] ?? 0), tx.currency);
    });
    setExactIds(group);
    setExact(values);
  };

  const setMode = (m: SplitMode) => {
    if (m === mode) return;
    const ids = mode === "exact" ? exactIds.filter((id) => !(friendPaid && id === payerId)) : serverIds;
    setModeState(m);
    if (m === "exact") {
      enterExact(ids);
      return;
    }
    if (friendPaid) actions.setSplit(tx.id, { participantIds: [payerId], mode: "equal", payerId });
    else if (ids.length) {
      actions.setSplit(tx.id, { participantIds: ids, mode: m });
      if (m !== "equal" && auto) {
        setAuto(false);
        actions.setAutoSplit(tx.id, false, [], true);
      }
    }
  };

  const toggle = (id: number) => {
    if (friendPaid) return;
    if (mode === "exact") {
      if (exactIds.includes(id)) setExactIds(exactIds.filter((x) => x !== id));
      else {
        setExactIds([...exactIds, id]);
        if (exact[id] === undefined) setExact({ ...exact, [id]: toInput(Math.max(total - exactSum, 0), tx.currency) });
      }
      return;
    }
    const next = serverIds.includes(id) ? serverIds.filter((x) => x !== id) : [...serverIds, id];
    if (mode === "full") {
      if (next.length) actions.setSplit(tx.id, { participantIds: next, mode: "full" });
      else actions.clearSplit(tx.id);
    } else {
      actions.toggleChip(tx.id, id);
      syncAuto(next);
    }
  };

  const saveExact = () => {
    if (invalid) return;
    const ids = friendPaid ? [payerId] : exactIds;
    if (ids.length === 0) {
      if (tx.splits.length) actions.clearSplit(tx.id);
      setModeState("equal");
      return;
    }
    actions.setSplit(tx.id, {
      participantIds: ids,
      mode: "exact",
      exact: ids.map((id) => ({ participantId: id, owedMinor: parse(exact[id] ?? "", tx.currency) ?? 0 })),
      ...(friendPaid ? { payerId } : {}),
    });
    if (auto) {
      setAuto(false);
      actions.setAutoSplit(tx.id, false, [], true);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTextInput(e.target)) return;
    if (/^[1-9]$/.test(e.key)) {
      const p = others[Number(e.key) - 1];
      if (p && !friendPaid) {
        e.preventDefault();
        toggle(p.id);
      }
    }
  };

  const n = checkedIds.length + 1;
  // This transaction's shares only, never a running balance (balances live only on Split and settle).
  const shareLines = checkedIds
    .filter((id) => !(friendPaid && id === payerId && owedOf(id) === 0))
    .map((id) => ({ id, minor: mode === "exact" ? (parse(exact[id] ?? "", tx.currency) ?? 0) : owedOf(id) }));

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <p className="flex items-baseline gap-2 text-body font-semibold">
        <span className="min-w-0 truncate">
          {t.aa.title} {tx.merchant || sourceTermLabel(tx.description, t) || t.aa.thisOne}
        </span>
        <Money minor={total} currency={tx.currency} className="ml-auto shrink-0" />
      </p>
      {reason && (
        <p data-testid="split-suggestion-reason" className="-mt-2 text-meta text-2">
          {reason}
        </p>
      )}

      <ul className="flex flex-col">
        <PersonLine
          name={t.common.me}
          checked
          disabled
          right={mode === "exact" ? <Money minor={Math.max(myShare, 0)} currency={tx.currency} className="text-meta text-2" /> : undefined}
          note={mode === "exact" ? t.aa.remaining : undefined}
        />
        {others.map((p, i) => {
          const on = checkedIds.includes(p.id);
          const locked = friendPaid;
          return (
            <PersonLine
              key={p.id}
              name={p.name}
              checked={on}
              disabled={locked}
              keyHint={!locked && i < 9 ? i + 1 : undefined}
              onToggle={() => toggle(p.id)}
              note={p.id === payerId && friendPaid ? t.aa.payer : undefined}
              right={
                on && mode === "exact" ? (
                  <input
                    inputMode="decimal"
                    aria-label={fmt(t.aa.shareAria, { name: p.name })}
                    value={exact[p.id] ?? ""}
                    onChange={(e) => setExact((x) => ({ ...x, [p.id]: e.target.value }))}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveExact();
                      }
                    }}
                    className="num h-7 w-24 rounded-md border border-border bg-background px-2 text-body outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25"
                  />
                ) : null
              }
            />
          );
        })}
        {!friendPaid && (
          <li>
            <AddPerson
              onAdd={async (name) => {
                const p = await actions.addParticipant(name);
                if (p) toggle(p.id);
              }}
            />
          </li>
        )}
      </ul>
      {friendPaid && <p className="text-meta text-2">{t.aa.friendPaidHint}</p>}

      <ModeSwitch value={mode} onChange={setMode} disabled={(m) => m === "full" && friendPaid} />

      <p className={cn("text-meta", invalid ? "text-foreground" : "text-2")} aria-live="polite">
        {invalid ??
          `${friendPaid ? fmt(t.aa.paidBy, { name: nameOf(payerId) }) : t.aa.paidByMe} · ${
            mode === "exact"
              ? fmt(t.aa.myShare, { amount: formatMinor(Math.max(myShare, 0), tx.currency) })
              : checkedIds.length === 0
                ? t.aa.noneYet
                : mode === "full"
                  ? fmt(t.aa.fullEach, { amount: shareAmounts(splitEqual(total, checkedIds.length), tx.currency) })
                  : fmt(t.aa.each, { amount: shareAmounts(splitEqual(total, n), tx.currency) })
          }`}
      </p>

      {canAuto && (
        <label className={cn("flex items-start gap-2.5 text-meta", autoAllowed || auto ? "cursor-pointer text-2" : "text-3")}>
          <input
            type="checkbox"
            checked={auto}
            disabled={!autoAllowed && !auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              actions.setAutoSplit(tx.id, e.target.checked, serverIds);
            }}
            className="mt-0.5 size-[15px] shrink-0 accent-[var(--brand)]"
          />
          <span className="min-w-0">
            {t.aa.autoRule.split("{merchant}").map((part, i) =>
              i === 0 ? (
                part
              ) : (
                <span key={i}>
                  <span className="text-foreground">{tx.merchant}</span>
                  {part}
                </span>
              ),
            )}
            {!autoAllowed && !auto && <span className="ml-1">{t.aa.autoRuleHint}</span>}
          </span>
        </label>
      )}

      {shareLines.length > 0 && (
        <div className="flex items-start gap-2 rounded-[10px] bg-background px-3 py-2.5">
          <UsersIcon className="mt-0.5 size-[15px] shrink-0 text-primary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            {shareLines.map((l) => (
              <p key={l.id} className="text-meta text-2">
                {t.aa.shareOfThis.split("{amount}").map((part, i) =>
                  i === 0 ? (
                    fmt(part, { name: nameOf(l.id) })
                  ) : (
                    <span key={i}>
                      <Money minor={l.minor} currency={tx.currency} className="font-semibold text-foreground" />
                      {part}
                    </span>
                  ),
                )}
              </p>
            ))}
          </div>
        </div>
      )}

      {tx.splits.some((x) => x.participantId !== selfId) && (
        <SharedNoteField
          txId={tx.id}
          names={tx.splits
            .filter((x) => x.participantId !== selfId)
            .map((x) => nameOf(x.participantId))
            .join(t.common.listSep)}
        />
      )}

      <div className="flex items-center gap-3 border-t border-border pt-2.5">
          {tx.splits.length > 0 && !friendPaid && (
            <button
              type="button"
              onClick={() => {
                actions.clearSplit(tx.id);
                setModeState("equal");
              }}
              className={footerDanger}
            >
              {t.aa.remove}
            </button>
          )}
          <span className="flex-1" />
          {mode === "exact" && (
            <Button variant="primary" size="sm" onClick={saveExact} disabled={Boolean(invalid)}>
              <CheckIcon aria-hidden />
              {t.aa.saveAmounts}
            </Button>
          )}
          <span className="hidden text-hint text-3 md:inline">{t.aa.escToClose}</span>
      </div>
    </div>
  );
}

/** Bulk: pick people, then Apply to N (equal split on every selected expense row). */
function BulkPanel({
  rows,
  count,
  others,
  selfId,
  onApply,
  onClear,
  onAdd,
}: {
  rows: Tx[];
  count: number;
  others: Participant[];
  selfId: number;
  onApply: (participantIds: number[]) => void;
  onClear: () => void;
  onAdd: (name: string) => Promise<Participant | null>;
}) {
  const t = useT();
  const splittable = rows.filter(canSplit);
  const [picked, setPicked] = useState<number[]>(() => {
    // Preselect the people every selected row already shares with.
    const states = splittable.map((t) => splitStateOf(t, selfId));
    if (states.length === 0 || states.some((s) => !s || s.payerId !== selfId)) return [];
    return states[0]!.participantIds.filter((id) => states.every((s) => s!.participantIds.includes(id)));
  });
  const friendPaid = splittable.filter((t) => {
    const s = splitStateOf(t, selfId);
    return s !== null && s.payerId !== selfId;
  }).length;
  const hasSplit = splittable.some((t) => t.splits.length > 0);
  const toggle = (id: number) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div
      className="flex flex-col gap-3"
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || isTextInput(e.target)) return;
        if (/^[1-9]$/.test(e.key)) {
          const p = others[Number(e.key) - 1];
          if (p) {
            e.preventDefault();
            toggle(p.id);
          }
        }
      }}
    >
      <p className="text-body font-semibold">{fmt(t.aa.bulkTitle, { count })}</p>
      <ul className="flex flex-col">
        <PersonLine name={t.common.me} checked disabled />
        {others.map((p, i) => (
          <PersonLine
            key={p.id}
            name={p.name}
            checked={picked.includes(p.id)}
            keyHint={i < 9 ? i + 1 : undefined}
            onToggle={() => toggle(p.id)}
          />
        ))}
      </ul>
      <AddPerson
        onAdd={async (name) => {
          const p = await onAdd(name);
          if (p) setPicked((cur) => [...cur, p.id]);
        }}
      />
      <p className="text-meta text-2">
        {t.aa.bulkPayer}
        {splittable.length < count && plural(t.aa.bulkNotExpense, count - splittable.length)}
        {friendPaid > 0 && plural(t.aa.bulkFriendPaid, friendPaid)}
      </p>
      <div className="flex items-center gap-2 border-t border-border pt-2.5">
        {hasSplit && (
          <button type="button" onClick={onClear} className={footerDanger}>
            {t.aa.bulkRemove}
          </button>
        )}
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          disabled={picked.length === 0 || splittable.length === 0}
          onClick={() => onApply(picked)}
        >
          <CheckIcon aria-hidden />
          {plural(t.aa.applyTo, splittable.length)}
        </Button>
      </div>
    </div>
  );
}

const content = "max-h-(--radix-popover-content-available-height) w-[min(340px,calc(100vw-2rem))] gap-0 overflow-y-auto rounded-2xl border border-line-strong bg-raised p-4 text-body shadow-dialog ring-0";
const edge = 8;

/**
 * The AA popover for one row. `trigger` is the part of the slot that toggles it; `anchor` wraps the whole
 * slot so the popover lines up with it (the suggestion pill has a second, accept-only button inside).
 */

/** "$35.60" when every share is the same, else the distinct shares largest first: "$35.60 / $35.59" (cents that do not divide). */
function shareAmounts(parts: number[], currency: string): string {
  return [...new Set(parts)].sort((a, b) => b - a).map((m) => formatMinor(m, currency)).join(" / ");
}

export function AaRowPopover({
  tx,
  others,
  selfId,
  nameOf,
  autoSplit,
  open,
  onOpenChange,
  actions,
  children,
}: {
  tx: Tx;
  others: Participant[];
  selfId: number;
  nameOf: (id: number) => string;
  autoSplit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: RowActions;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {children}
      <PopoverContent align="end" collisionPadding={edge} className={content} onCloseAutoFocus={(e) => e.preventDefault()}>
        {open && (
          <RowPanel tx={tx} others={others} selfId={selfId} nameOf={nameOf} autoSplit={autoSplit} actions={actions} />
        )}
      </PopoverContent>
    </Popover>
  );
}

export { PopoverAnchor as AaAnchor, PopoverTrigger as AaTrigger };

export function AaBulkPopover({
  rows,
  count,
  others,
  selfId,
  onApply,
  onClear,
  onAdd,
  children,
}: {
  rows: Tx[];
  count: number;
  others: Participant[];
  selfId: number;
  onApply: (participantIds: number[]) => void;
  onClear: () => void;
  onAdd: (name: string) => Promise<Participant | null>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={10} collisionPadding={edge} className={content}>
        {open && (
          <BulkPanel
            rows={rows}
            count={count}
            others={others}
            selfId={selfId}
            onAdd={onAdd}
            onApply={(ids) => {
              onApply(ids);
              setOpen(false);
            }}
            onClear={() => {
              onClear();
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

