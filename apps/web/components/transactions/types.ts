import type { Category, CurrencyTotal, Participant, TransactionItem } from "@yomi/contracts";

export type Tx = TransactionItem;
export type { Category, CurrencyTotal, Participant };

export interface TxFilters {
  q: string;
  categoryId?: number;
  /** One kind of row (?kind=): spending (expense), income, transfers or refunds. */
  kind?: Tx["kind"];
  participantId?: number;
  uncategorized: boolean;
  /** Catching up on old bills: only my own unsplit expenses (?unsplit=1). */
  unsplit: boolean;
  showAll: boolean;
}

/** The kinds the type filter offers, in its order. */
export const TX_KINDS = ["expense", "income", "transfer", "refund"] as const satisfies readonly Tx["kind"][];

/** Some filter narrows the list (the spend strip still shows the whole period). */
export function hasFilters(f: TxFilters): boolean {
  return Boolean(f.q || f.categoryId || f.kind || f.participantId || f.uncategorized || f.unsplit);
}

export type PanelType = "category" | "split" | "menu" | "note" | "details";

export interface Panel {
  id: number;
  type: PanelType;
}

/** Stable callbacks a row calls; all take the row id so rows can stay memoized. */
export interface RowActions {
  focus(id: number): void;
  select(id: number, opts: { shift: boolean }): void;
  /** One-tap participant toggle (core toggle-participant). */
  toggleChip(id: number, participantId: number): void;
  setCategory(id: number, categoryId: number, applyToMerchant: boolean): void;
  setSplit(
    id: number,
    body: {
      participantIds: number[];
      mode: "equal" | "full" | "exact";
      exact?: { participantId: number; owedMinor: number }[];
      /** Friend-paid rows keep their payer. */
      payerId?: number;
    },
  ): void;
  /** Turns the row merchant's "split like this from now on" rule on/off with these people; `quiet` skips the toast. */
  setAutoSplit(id: number, enabled: boolean, participantIds: number[], quiet?: boolean): void;
  /** Creates a participant (from the AA popover); null when the server refused. */
  addParticipant(name: string): Promise<Participant | null>;
  clearSplit(id: number): void;
  /** "Not this one": hide this row's split suggestion (toast with Undo). */
  dismissSuggestion(id: number): void;
  /** "Don't suggest for this merchant": a negative merchant rule (toast with Undo). */
  muteMerchant(id: number): void;
  setKind(id: number, kind: Tx["kind"]): void;
  setNote(id: number, note: string | null): void;
  openPanel(id: number, type: PanelType | null): void;
}
