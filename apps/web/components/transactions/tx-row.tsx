"use client";

import { BellOffIcon, CheckIcon, ChevronDownIcon, EllipsisIcon, UsersIcon, XIcon } from "lucide-react";
import { memo, type ReactNode, useRef, useState } from "react";
import { ProvisionalLabel } from "@/components/capture/provisional";
import { CategoryTile, sourceIcon } from "@/components/category-icon";
import { Money } from "@/components/money";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmt } from "@/i18n";
import { accountLabel } from "@/i18n/accounts";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { displayDescription, sourceTermLabel } from "@/i18n/source-terms";
import { cn } from "@/lib/utils";
import { AaAnchor, AaRowPopover } from "./aa-popover";
import { CategoryMenu } from "./category-menu";
import { canSplit, splitStateOf } from "./split-math";
import { suggestionReason } from "./suggestion";
import type { Category, Participant, PanelType, RowActions, Tx } from "./types";

export interface TxRowProps {
  tx: Tx;
  others: Participant[];
  selfId: number;
  nameOf: (id: number) => string;
  categories: Category[];
  selected: boolean;
  focused: boolean;
  selecting: boolean;
  panel: PanelType | null;
  actions: RowActions;
  /** Unsplit only: this row was dealt with since the list loaded; dim it and mark it split, keep it in place. */
  done?: boolean;
  /** The merchant's rule splits new rows automatically. */
  autoSplit?: boolean;
  /** The md layout and up (TxView's one useIsDesktop). */
  desktop: boolean;
}

const marker =
  "inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2.5 text-meta whitespace-nowrap transition-colors duration-[120ms] ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-md:h-8 max-md:px-2.5";

/**
 * The Split marker column: "Split · N" (soft accent) on split rows, a dashed "Roommate?" suggestion (the name accepts in
 * one tap and carries the reason as its tooltip, the icon opens the popover, the chevron has "Not this one" and "Don't
 * suggest for this merchant"), or a faint "Split" that shows on hover or focus (always faintly on phones).
 */
function AaSlot({
  tx,
  others,
  selfId,
  nameOf,
  open,
  focused,
  autoSplit,
  actions,
}: {
  tx: Tx;
  others: Participant[];
  selfId: number;
  nameOf: (id: number) => string;
  open: boolean;
  focused: boolean;
  autoSplit: boolean;
  actions: RowActions;
}) {
  const t = useT();
  const s = t.aa.slot;
  const state = splitStateOf(tx, selfId);
  const suggestion = state ? null : tx.suggestion;
  const suggested = suggestion?.participantIds ?? [];
  const onOpenChange = (o: boolean) => actions.openPanel(tx.id, o ? "split" : null);
  const icon = <UsersIcon className="size-3.5 shrink-0 max-md:hidden" aria-hidden />;
  // A plain button, not Radix's PopoverTrigger: the popover is controlled, and a PopoverTrigger beside the custom
  // anchor below rewraps itself after hydration, remounting every row's button.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const trigger = { ref: triggerRef, "aria-haspopup": "dialog", "aria-expanded": open, onClick: () => onOpenChange(!open) } as const;

  let body: ReactNode;
  if (state) {
    const friendPaid = state.payerId !== selfId;
    const names = state.participantIds.map(nameOf).join(t.common.listSep);
    const payer = nameOf(state.payerId);
    body = (
      <button
        type="button"
        {...trigger}
        aria-label={friendPaid ? fmt(s.friendPaidAria, { name: payer }) : fmt(s.withAria, { names })}
        title={friendPaid ? fmt(s.friendPaidTitle, { name: payer }) : fmt(s.withTitle, { names })}
        className={cn(marker, "hit relative bg-primary-soft font-medium text-primary-soft-foreground hover:brightness-110 md:w-full")}
      >
        {icon}
        <span className="truncate">{friendPaid ? fmt(s.friendPaid, { name: payer }) : fmt(s.people, { count: state.participantIds.length + 1 })}</span>
      </button>
    );
  } else if (suggested.length > 0) {
    const names = suggested.map(nameOf).join(t.common.listSep);
    const reason = suggestion ? suggestionReason(suggestion, t, nameOf) : null;
    body = (
      <span className={cn(marker, "gap-0 border border-dashed border-line-strong px-0 text-2 max-md:px-0 md:w-full")}>
        <button
          type="button"
          {...trigger}
          aria-label={s.settings}
          title={s.settingsTitle}
          className="hit relative inline-flex h-full shrink-0 items-center gap-1 rounded-l-full pr-1 pl-2.5 hover:text-primary max-md:pr-2"
        >
          <UsersIcon className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={fmt(s.suggestAria, { names })}
          aria-description={reason ?? undefined}
          title={reason ? fmt(s.suggestTitleWith, { reason }) : fmt(s.suggestTitle, { names })}
          onClick={() =>
            suggested.length === 1
              ? actions.toggleChip(tx.id, suggested[0]!)
              : actions.setSplit(tx.id, { participantIds: suggested, mode: "equal" })
          }
          className="hit relative h-full min-w-0 truncate text-left hover:text-primary max-md:px-1"
        >
          {names}?
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={s.suggestMenu}
              title={s.suggestMenu}
              className="hit relative inline-flex h-full shrink-0 items-center rounded-r-full pr-2 pl-0.5 text-2 hover:text-foreground max-md:pr-2.5 max-md:pl-1.5"
            >
              <ChevronDownIcon className="size-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-xl bg-raised p-1 shadow-dialog ring-1 ring-line-strong" onCloseAutoFocus={(e) => e.preventDefault()}>
            {reason && <p className="px-2 pt-1.5 pb-1 text-meta text-2">{reason}</p>}
            <DropdownMenuItem className="h-9 gap-2 text-body" onSelect={() => actions.dismissSuggestion(tx.id)}>
              <XIcon className="size-4 text-2" aria-hidden />
              {s.notThisOne}
            </DropdownMenuItem>
            {tx.merchant && (
              <DropdownMenuItem className="h-9 gap-2 text-body" onSelect={() => actions.muteMerchant(tx.id)}>
                <BellOffIcon className="size-4 text-2" aria-hidden />
                <span className="truncate">{fmt(s.dontSuggest, { merchant: tx.merchant })}</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    );
  } else {
    body = (
      <button
        type="button"
        {...trigger}
        aria-label={s.label}
        title={s.title}
        className={cn(
          marker,
          "border border-transparent text-2 hover:border-border hover:text-foreground focus-visible:opacity-100",
          // Phones: no faint marker on every row (the row menu has Split); it stays as the popover's anchor.
          "max-md:pointer-events-none max-md:h-0 max-md:overflow-hidden max-md:border-0 max-md:opacity-0",
          open || focused ? "md:opacity-100" : "md:opacity-0 md:group-hover/row:opacity-100",
        )}
      >
        {icon}
        {s.label}
      </button>
    );
  }

  return (
    <AaRowPopover
      tx={tx}
      others={others}
      selfId={selfId}
      nameOf={nameOf}
      autoSplit={autoSplit}
      open={open}
      onOpenChange={onOpenChange}
      triggerRef={triggerRef}
      actions={actions}
    >
      <AaAnchor asChild>
        <span className="flex min-w-0 max-md:justify-end">{body}</span>
      </AaAnchor>
    </AaRowPopover>
  );
}

function NoteEditor({ tx, onDone }: { tx: Tx; onDone: (note: string | null | undefined) => void }) {
  const t = useT();
  const [value, setValue] = useState(tx.note ?? "");
  const done = useRef(false);
  const finish = (note: string | null | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(note);
  };
  return (
    <input
      autoFocus
      value={value}
      maxLength={500}
      placeholder={t.transactions.row.notePlaceholder}
      aria-label={t.common.note}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value.trim() || null);
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(undefined);
        }
      }}
      onBlur={() => finish(value.trim() === (tx.note ?? "") ? undefined : value.trim() || null)}
      className="h-6 w-full min-w-0 rounded-sm border border-border bg-background px-1.5 text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    />
  );
}

const badge = "shrink-0 rounded-sm bg-tile px-1.5 text-hint font-normal";

function TxRowImpl({ tx, others, selfId, nameOf, categories, selected, focused, selecting, panel, actions, done, autoSplit, desktop }: TxRowProps) {
  const t = useT();
  const r = t.transactions.row;
  const splittable = canSplit(tx);
  const hidden = tx.status !== "ok" || tx.duplicateOfId != null;
  const transfer = tx.kind === "transfer";
  const hasSplit = tx.splits.length > 0;
  const mine = Math.abs(tx.myShareMinor);
  const showMine = hasSplit && !transfer && !hidden && mine !== Math.abs(tx.amountMinor);
  const SourceIcon = sourceIcon(tx);

  const origin = tx.accountName ? accountLabel(tx.accountName, t) : (t.transactions.sources[tx.source] ?? tx.source);
  const meta = [
    // One leg of a transfer between my accounts names the other leg's account.
    transfer && tx.transferAccountName ? fmt(r.transferPeer, { account: accountLabel(tx.transferAccountName, t) }) : null,
    desktop ? null : tx.categoryName ? categoryLabel(tx.categoryName, t) : null,
    // Phones keep the category and drop the source (it is in the details), so the meta does not truncate to a stub.
    desktop || !tx.categoryName ? origin : null,
    tx.note,
    // Without a merchant the description is the row's title already.
    tx.merchant || tx.counterpartyRaw ? displayDescription(tx, t) : null,
    tx.source === "sms" ? r.badgeAuto : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const slot = splittable ? (
    <AaSlot
      tx={tx}
      others={others}
      selfId={selfId}
      nameOf={nameOf}
      open={panel === "split"}
      focused={focused}
      autoSplit={Boolean(autoSplit)}
      actions={actions}
    />
  ) : null;

  const categoryMenu = (variant: "pill" | "tile") => (
    <CategoryMenu
      tx={tx}
      categories={categories}
      open={panel === "category"}
      onOpenChange={(o) => actions.openPanel(tx.id, o ? "category" : null)}
      onPick={(cid, apply) => actions.setCategory(tx.id, cid, apply)}
      variant={variant}
    />
  );

  return (
    <div
      role="row"
      aria-selected={selected}
      data-tx-id={tx.id}
      data-focused={focused || undefined}
      onMouseDown={() => {
        if (!focused) actions.focus(tx.id);
      }}
      className={cn(
        "group/row relative flex min-h-row-phone items-center gap-3 border-b border-line-soft px-4 py-2 last:border-b-0 md:h-row md:gap-4 md:py-0 md:pr-3 md:pl-5",
        "transition-colors duration-[120ms] ease-out hover:bg-tile/40",
        selected && "bg-primary-soft/60 hover:bg-primary-soft/60",
        focused && "shadow-[inset_2px_0_0_var(--brand)]",
        (hidden || done) && "opacity-55",
      )}
    >
      {/* Tile: selects the row on desktop (a checkbox on hover), opens the category menu on phones. */}
      {desktop ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={r.select}
          tabIndex={-1}
          onClick={(e) => actions.select(tx.id, { shift: e.shiftKey })}
          className="relative shrink-0 rounded-[10px] outline-none"
        >
          <CategoryTile name={tx.categoryName} kind={tx.kind} />
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 flex items-center justify-center rounded-[10px] transition-opacity duration-[120ms]",
              selected ? "bg-primary text-primary-foreground opacity-100" : "bg-tile opacity-0 group-hover/row:opacity-100",
              !selected && (selecting || focused) && "opacity-100",
            )}
          >
            {selected ? (
              <CheckIcon className="size-4" />
            ) : (
              <span className="size-4 rounded-[4px] border-[1.5px] border-foreground/35" />
            )}
          </span>
        </button>
      ) : (
        categoryMenu("tile")
      )}

      {/* merchant + meta */}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-body font-medium", transfer && "text-transfer")}>
            {tx.merchant || tx.counterpartyRaw || sourceTermLabel(tx.description, t) || r.noMerchant}
          </span>
          {transfer && <span className={cn(badge, "text-transfer")}>{r.notSpending}</span>}
          {hidden && <span className={cn(badge, "text-3")}>{tx.duplicateOfId != null ? r.badgeDuplicate : r.badgeClosed}</span>}
          {done && hasSplit && <span className={cn(badge, "text-2")}>{r.badgeSplit}</span>}
        </div>
        {panel === "note" ? (
          <NoteEditor
            tx={tx}
            onDone={(note) => {
              if (note !== undefined && note !== tx.note) actions.setNote(tx.id, note);
              actions.openPanel(tx.id, null);
            }}
          />
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-meta text-2" title={tx.source === "sms" ? r.autoTitle : undefined}>
            {tx.provisional ? (
              <>
                <ProvisionalLabel kind={tx.provisional} />
                <span aria-hidden>·</span>
              </>
            ) : (
              <SourceIcon className="size-[13px] shrink-0 max-md:hidden" aria-hidden />
            )}
            <span className="truncate">{meta}</span>
          </span>
        )}
      </div>

      {/* category pill (desktop) */}
      {desktop && <div className="w-[124px] shrink-0">{categoryMenu("pill")}</div>}

      {/* Split marker: its own column on desktop, under the amount on phones */}
      {desktop && <div className="flex w-[120px] shrink-0 items-center">{slot}</div>}

      {/* amount + my share */}
      <div className="flex shrink-0 flex-col items-end justify-center gap-1 md:w-[120px] md:gap-0.5">
        <Money
          minor={tx.amountMinor}
          currency={tx.currency}
          sign="inflow"
          tone={transfer || hidden ? "muted" : undefined}
          className={cn("text-body font-medium", transfer && "text-transfer")}
        />
        {showMine && desktop && (
          <span className="inline-flex items-baseline gap-1 text-hint leading-4 text-2">
            {r.mine}
            <Money minor={mine} currency={tx.currency} tone="muted" />
          </span>
        )}
        {!desktop && slot}
      </div>

      {/* row menu */}
      <div className="shrink-0">
        <DropdownMenu open={panel === "menu"} onOpenChange={(o) => actions.openPanel(tx.id, o ? "menu" : null)} modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={r.moreActions}
              className={cn(
                "hit relative inline-flex size-8 items-center justify-center rounded-lg text-2 transition-opacity duration-[120ms] hover:bg-tile hover:text-foreground max-md:-mr-1.5",
                panel === "menu" || focused ? "opacity-100" : "md:opacity-60 md:group-hover/row:opacity-100",
              )}
            >
              <EllipsisIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 rounded-xl bg-raised p-1 shadow-dialog ring-1 ring-line-strong" onCloseAutoFocus={(e) => e.preventDefault()}>
            {!desktop && splittable && (
              <DropdownMenuItem
                className="h-9 text-body"
                onSelect={() => {
                  // Let the menu close first so the popover keeps focus.
                  window.setTimeout(() => actions.openPanel(tx.id, "split"), 0);
                }}
              >
                {t.aa.slot.label}
              </DropdownMenuItem>
            )}
            {!desktop && (
              <DropdownMenuItem className="h-9 text-body" onSelect={() => actions.select(tx.id, { shift: false })}>
                {r.select}
              </DropdownMenuItem>
            )}
            {transfer ? (
              <DropdownMenuItem className="h-9 text-body" onSelect={() => actions.setKind(tx.id, tx.amountMinor < 0 ? "expense" : "income")}>
                {r.unmarkTransfer}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem className="h-9 text-body" onSelect={() => actions.setKind(tx.id, "transfer")}>
                {r.markTransfer}
                <span className="ml-auto text-hint text-3">{r.notSpending}</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="h-9 text-body"
              onSelect={() => {
                // Let the menu close (and restore focus) before the inline input takes focus.
                window.setTimeout(() => actions.openPanel(tx.id, "note"), 0);
              }}
            >
              {tx.note ? r.editNote : r.addNote}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="h-9 text-body" onSelect={() => actions.openPanel(tx.id, "details")}>
              {r.sourceDetails}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function sameTx(a: Tx, b: Tx): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export const TxRow = memo(TxRowImpl, (a, b) =>
  sameTx(a.tx, b.tx) &&
  a.others === b.others &&
  a.categories === b.categories &&
  a.selected === b.selected &&
  a.focused === b.focused &&
  a.selecting === b.selecting &&
  a.panel === b.panel &&
  a.done === b.done &&
  a.autoSplit === b.autoSplit &&
  a.desktop === b.desktop &&
  a.actions === b.actions &&
  a.nameOf === b.nameOf &&
  a.selfId === b.selfId,
);
