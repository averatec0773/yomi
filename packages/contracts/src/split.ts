import { z } from "zod";
import { CurrencyCode, Locale } from "./common";
import { StatementPayment } from "./payment";

const Id = z.int().positive();
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Currency = z.string().trim().toUpperCase().pipe(CurrencyCode);
/** Units of the other currency per 1 unit of the base currency, as a decimal string ("7.2"). */
const FxRate = z.string().trim().regex(/^\d{1,12}(\.\d{1,12})?$/, "a positive decimal, e.g. 7.2");

export const IdentityKind = z.enum(["wechat", "alipay", "zelle_name", "zelle_email", "zelle_phone", "venmo", "bank_name", "other"]);
export type IdentityKind = z.infer<typeof IdentityKind>;

export const Identity = z.object({
  id: z.int(),
  participantId: z.int(),
  kind: IdentityKind,
  value: z.string(),
  normalized: z.string(),
  source: z.enum(["manual", "claimed"]),
  createdAt: z.string(),
});
export type Identity = z.infer<typeof Identity>;

export const IdentityInput = z.object({ kind: IdentityKind, value: z.string().trim().min(1).max(120) });
export type IdentityInput = z.infer<typeof IdentityInput>;

export const Participant = z.object({
  id: z.int(),
  name: z.string(),
  isSelf: z.boolean(),
  identities: z.array(Identity),
  archivedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type Participant = z.infer<typeof Participant>;

export const ParticipantList = z.object({ participants: z.array(Participant) });
export type ParticipantList = z.infer<typeof ParticipantList>;

export const CreateParticipantBody = z.object({
  name: z.string().min(1),
  identities: z.array(IdentityInput).optional(),
});
export type CreateParticipantBody = z.infer<typeof CreateParticipantBody>;

export const PatchParticipantBody = z
  .object({
    name: z.string().min(1).optional(),
    archived: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.archived !== undefined, "nothing to update");
export type PatchParticipantBody = z.infer<typeof PatchParticipantBody>;

export const DeleteIdentityResult = z.object({ deleted: z.literal(true) });
export type DeleteIdentityResult = z.infer<typeof DeleteIdentityResult>;

/** A person-to-person counterparty found in the ledger and not yet bound to a participant. */
export const UnclaimedCounterparty = z.object({
  kind: IdentityKind,
  value: z.string(),
  normalized: z.string(),
  inCount: z.int().nonnegative(),
  outCount: z.int().nonnegative(),
  /** Per currency, never summed across. inMinor / outMinor are positive magnitudes. */
  totals: z.array(z.object({ currency: CurrencyCode, inMinor: z.int().nonnegative(), outMinor: z.int().nonnegative() })),
  firstAt: z.string(),
  lastAt: z.string(),
  lastDirection: z.enum(["in", "out"]),
  sources: z.array(z.string()),
  account: z.string().nullable(),
  suggestedParticipantId: z.int().nullable(),
});
export type UnclaimedCounterparty = z.infer<typeof UnclaimedCounterparty>;

export const UnclaimedCounterpartyList = z.object({ counterparties: z.array(UnclaimedCounterparty) });
export type UnclaimedCounterpartyList = z.infer<typeof UnclaimedCounterpartyList>;

/** Exactly one of participantId / newParticipantName. */
export const ClaimCounterpartyBody = IdentityInput.extend({
  participantId: Id.optional(),
  newParticipantName: z.string().trim().min(1).max(40).optional(),
}).refine((b) => (b.participantId === undefined) !== (b.newParticipantName === undefined), "participantId or newParticipantName");
export type ClaimCounterpartyBody = z.infer<typeof ClaimCounterpartyBody>;

export const ClaimCounterpartyResult = z.object({ identity: Identity, participantId: z.int() });
export type ClaimCounterpartyResult = z.infer<typeof ClaimCounterpartyResult>;

export const IgnoreCounterpartyResult = z.object({ ignored: z.literal(true) });
export type IgnoreCounterpartyResult = z.infer<typeof IgnoreCounterpartyResult>;

export const SplitMode = z.enum(["equal", "full", "exact"]);
export type SplitMode = z.infer<typeof SplitMode>;

export const ExactShare = z.object({ participantId: Id, owedMinor: z.int().nonnegative() });

export const SetSplitBody = z.object({
  participantIds: z.array(Id),
  mode: SplitMode.default("equal"),
  exact: z.array(ExactShare).optional(),
  payerId: Id.optional(),
});
export type SetSplitBody = z.infer<typeof SetSplitBody>;

export const SplitRow = z.object({
  participantId: z.int(),
  name: z.string(),
  isSelf: z.boolean(),
  owedMinor: z.int(),
  paidMinor: z.int(),
});

export const SplitView = z.object({
  transactionId: z.int(),
  currency: CurrencyCode,
  totalMinor: z.int(),
  mode: SplitMode,
  payerId: z.int(),
  participantIds: z.array(z.int()),
  myShareMinor: z.int(),
  rows: z.array(SplitRow),
});
export type SplitView = z.infer<typeof SplitView>;

/** `split: null` means the row has no split. `resetExact` (chip toggles only): an exact split was re-split equally. */
export const SplitResult = z.object({ split: SplitView.nullable(), resetExact: z.boolean().optional() });
export type SplitResult = z.infer<typeof SplitResult>;

export const ToggleParticipantBody = z.object({ participantId: Id });
export type ToggleParticipantBody = z.infer<typeof ToggleParticipantBody>;

export const BulkToggleBody = z.object({
  transactionIds: z.array(Id).min(1),
  participantId: Id,
  on: z.boolean(),
});
export type BulkToggleBody = z.infer<typeof BulkToggleBody>;

export const BulkToggleResult = z.object({
  updated: z.array(z.int()),
  unchanged: z.array(z.int()),
  skipped: z.array(z.object({ transactionId: z.int(), code: z.string(), reason: z.string() })),
});
export type BulkToggleResult = z.infer<typeof BulkToggleResult>;

/** POST /api/split/accept-suggestions and its undo: the rows (on screen) whose suggestions to accept or revert. */
export const AcceptSuggestionsBody = z.object({ transactionIds: z.array(Id).min(1).max(2000) });
export type AcceptSuggestionsBody = z.infer<typeof AcceptSuggestionsBody>;

export const AcceptSuggestionsResult = z.object({
  accepted: z.array(z.object({ transactionId: z.int(), participantIds: z.array(z.int()) })),
  skipped: z.array(z.object({ transactionId: z.int(), code: z.string(), reason: z.string() })),
});
export type AcceptSuggestionsResult = z.infer<typeof AcceptSuggestionsResult>;

export const RevertSuggestionsResult = z.object({ reverted: z.array(z.int()) });
export type RevertSuggestionsResult = z.infer<typeof RevertSuggestionsResult>;

/** "Not this one" (dismissed true) and its undo. */
export const DismissSuggestionBody = z.object({ dismissed: z.boolean().default(true) });
export type DismissSuggestionBody = z.infer<typeof DismissSuggestionBody>;

export const DismissSuggestionResult = z.object({ transactionId: z.int(), dismissed: z.boolean() });
export type DismissSuggestionResult = z.infer<typeof DismissSuggestionResult>;

/** "Don't suggest for this merchant" (suggest false) and its undo (suggest true, optionally restoring people). */
export const MerchantSuggestBody = z.object({
  merchant: z.string().trim().min(1),
  suggest: z.boolean(),
  participantIds: z.array(Id).optional(),
});
export type MerchantSuggestBody = z.infer<typeof MerchantSuggestBody>;

export const MerchantSuggestResult = z.object({
  merchant: z.string(),
  suggest: z.boolean(),
  previousParticipantIds: z.array(z.int()),
});
export type MerchantSuggestResult = z.infer<typeof MerchantSuggestResult>;

export const Balance = z.object({
  participantId: z.int(),
  name: z.string(),
  archived: z.boolean(),
  currency: CurrencyCode,
  /** Positive: they owe me. Negative: I owe them. */
  owedToMeMinor: z.int(),
  lastSettledOn: z.string().nullable(),
  openItemCount: z.int().nonnegative(),
});
export type Balance = z.infer<typeof Balance>;

export const BalanceList = z.object({ balances: z.array(Balance) });
export type BalanceList = z.infer<typeof BalanceList>;

export const Settlement = z.object({
  id: z.int(),
  participantId: z.int(),
  participantName: z.string(),
  amountMinor: z.int(),
  currency: CurrencyCode,
  originalAmountMinor: z.int().nullable(),
  originalCurrency: z.string().nullable(),
  /** Units of originalCurrency per 1 unit of currency; null without a different original currency. */
  fxRate: z.string().nullable(),
  settledOn: z.string(),
  note: z.string().nullable(),
  transactionId: z.int().nullable(),
  createdAt: z.string(),
  /** 'opening': an opening balance rather than a payment. */
  kind: z.enum(["payment", "opening"]),
  /** Same as kind === "opening". */
  opening: z.boolean(),
});
export type Settlement = z.infer<typeof Settlement>;

export const SettlementList = z.object({ settlements: z.array(Settlement) });
export type SettlementList = z.infer<typeof SettlementList>;

export const RecordSettlementBody = z.object({
  participantId: Id,
  /** Signed: + they paid me, - I paid them. */
  amountMinor: z.int().refine((n) => n !== 0, "must be non-zero"),
  currency: Currency,
  originalAmountMinor: z.int().nullish(),
  originalCurrency: Currency.nullish(),
  /** With originalCurrency: the other side of originalAmountMinor; one of the two is enough. */
  fxRate: FxRate.nullish(),
  settledOn: IsoDate,
  note: z.string().nullish(),
  transactionId: Id.nullish(),
  /** Open split items (same person and currency) this settlement pays; amountMinor may be less than their sum. */
  itemTransactionIds: z.array(Id).max(1000).nullish(),
});
export type RecordSettlementBody = z.infer<typeof RecordSettlementBody>;

export const DeleteSettlementResult = z.object({ deleted: z.literal(true), restoredTransactionId: z.int().nullable() });
export type DeleteSettlementResult = z.infer<typeof DeleteSettlementResult>;

export const SettleAllBody = z.object({
  participantId: Id,
  currency: Currency,
  originalAmountMinor: z.int().nullish(),
  originalCurrency: Currency.nullish(),
  fxRate: FxRate.nullish(),
  settledOn: IsoDate,
  note: z.string().nullish(),
  transactionId: Id.nullish(),
});
export type SettleAllBody = z.infer<typeof SettleAllBody>;

export const OpeningBalanceBody = z.object({
  participantId: Id,
  direction: z.enum(["they_owe_me", "i_owe_them"]),
  /** Magnitude in minor units. */
  amountMinor: z.int().positive(),
  currency: Currency,
  date: IsoDate,
  note: z.string().nullish(),
});
export type OpeningBalanceBody = z.infer<typeof OpeningBalanceBody>;

/** "Start counting from a day, everything before is even": settles everything dated before `from`. */
export const ClearBeforeBody = z.object({
  participantId: Id,
  currency: Currency,
  from: IsoDate,
  note: z.string().nullish(),
});
export type ClearBeforeBody = z.infer<typeof ClearBeforeBody>;

export const SettlementCandidate = z.object({
  transactionId: z.int(),
  occurredAt: z.string(),
  source: z.string(),
  sourceCategory: z.string().nullable(),
  counterparty: z.string(),
  amountMinor: z.int(),
  currency: CurrencyCode,
  match: z.enum(["alias_exact", "alias_contains", "none"]),
  suggestedParticipantId: z.int().nullable(),
  /** null: the sender owes in another currency and no rate is known; the user types the amount. */
  suggestedAmountMinor: z.int().nullable(),
  suggestedCurrency: CurrencyCode,
  balances: z.array(z.object({ currency: CurrencyCode, owedToMeMinor: z.int() })),
  /** An unlinked manual settlement that may already cover this transfer. */
  possiblyCovered: z
    .object({ settlementId: z.int(), amountMinor: z.int(), currency: CurrencyCode, settledOn: z.string() })
    .nullable(),
});
export type SettlementCandidate = z.infer<typeof SettlementCandidate>;

export const CandidateList = z.object({ candidates: z.array(SettlementCandidate) });
export type CandidateList = z.infer<typeof CandidateList>;

export const MarkSettlementBody = z.object({
  participantId: Id,
  /** Magnitude; the sign follows the transaction. Required when `currency` differs from the transaction's. */
  amountMinor: z.int().positive().optional(),
  currency: Currency.optional(),
  /** When currency differs: units of the transaction's currency per 1 unit of `currency`; replaces amountMinor. */
  fxRate: FxRate.nullish(),
  note: z.string().nullish(),
});
export type MarkSettlementBody = z.infer<typeof MarkSettlementBody>;

export const FriendPaidBody = z.object({
  payerId: Id,
  totalMinor: z.int().positive(),
  currency: Currency,
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/),
  description: z.string(),
  categoryId: Id.nullish(),
  participantIds: z.array(Id).optional(),
  mode: SplitMode.optional(),
  exact: z.array(ExactShare).optional(),
});
export type FriendPaidBody = z.infer<typeof FriendPaidBody>;

export const CreatedEntry = z.object({
  transactionId: z.int(),
  split: SplitView.nullable(),
  myShareMinor: z.int(),
});
export type CreatedEntry = z.infer<typeof CreatedEntry>;

export const StatementScope = z.enum(["open", "all", "selected"]);
export type StatementScope = z.infer<typeof StatementScope>;

/** What a statement shows besides the items; see STATEMENT_FLAGS in core. */
export const StatementFlag = z.enum(["shared", "names", "myshare", "notes", "settlements", "category", "payment"]);
export type StatementFlag = z.infer<typeof StatementFlag>;
/** Applied when `show` is absent: who shared as a count, notes, settlements and how to pay; no names, my share or category. */
export const DEFAULT_STATEMENT_FLAGS: readonly StatementFlag[] = ["shared", "notes", "settlements", "payment"];

export const StatementQuery = z.object({
  participantId: z.coerce.number().pipe(Id),
  currency: Currency,
  since: IsoDate.optional(),
  /** First day of the recent settlements list (default: 60 days ago). */
  recentSince: IsoDate.optional(),
  /** Language of `text` (and of the CSV export); default English. */
  locale: Locale.optional(),
  /** Which items: open ones (default), all of them, or `items` (scope "selected"). */
  scope: StatementScope.optional(),
  /** Comma-separated transaction ids, for scope "selected" only. */
  items: z
    .string()
    .regex(/^\d+(,\d+)*$/, "comma-separated ids")
    .transform((v) => [...new Set(v.split(",").map(Number))])
    .pipe(z.array(Id).min(1).max(2000))
    .optional(),
  /** Comma-separated StatementFlag values; empty shows none of them; absent means DEFAULT_STATEMENT_FLAGS. */
  show: z
    .string()
    .transform((v) => (v === "" ? [] : [...new Set(v.split(","))]))
    .pipe(z.array(StatementFlag).max(7))
    .optional(),
}).superRefine((q, ctx) => {
  if (q.scope === "selected" && !q.items) ctx.addIssue({ code: "custom", path: ["items"], message: "required when scope is selected" });
  if (q.items && q.scope !== "selected") ctx.addIssue({ code: "custom", path: ["items"], message: "only with scope=selected" });
});
export type StatementQuery = z.infer<typeof StatementQuery>;

const ItemStatus = z.enum(["open", "partial", "covered"]);

const StatementItemDetails = z.object({
  /** People with a share of the item, me included. */
  splitCount: z.int(),
  /** Others with a share, besides me and this participant. */
  sharedWith: z.array(z.string()),
  /** My own share, signed like theirShareMinor. */
  myShareMinor: z.int(),
  /** Stored category name. */
  category: z.string().nullable(),
});

export const StatementEntry = z.object({
  transactionId: z.int(),
  date: z.string(),
  merchant: z.string(),
  totalMinor: z.int(),
  theirShareMinor: z.int(),
  paidByThem: z.boolean(),
  deltaMinor: z.int(),
  /** Still open, signed like delta; 0 when covered. */
  remainingMinor: z.int(),
  status: ItemStatus,
  sharedNote: z.string().nullable(),
  /** Day the item became settled for good; null unless covered. */
  settledOn: z.string().nullable(),
  ...StatementItemDetails.shape,
});
export type StatementEntry = z.infer<typeof StatementEntry>;

export const Statement = z.object({
  participantId: z.int(),
  participantName: z.string(),
  /** The user's display name (Settings > Profile), or null: labels "my share" as "Sam's share". */
  myName: z.string().nullable(),
  currency: CurrencyCode,
  since: z.string().nullable(),
  openingMinor: z.int(),
  openingBalanceMinor: z.int(),
  items: z.array(
    z.object({
      transactionId: z.int(),
      date: z.string(),
      merchant: z.string(),
      totalMinor: z.int(),
      theirShareMinor: z.int(),
      paidByThem: z.boolean(),
      deltaMinor: z.int(),
      ...StatementItemDetails.shape,
    }),
  ),
  settlements: z.array(
    z.object({
      settlementId: z.int(),
      date: z.string(),
      amountMinor: z.int(),
      originalAmountMinor: z.int().nullable(),
      originalCurrency: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  openItems: z.array(StatementEntry),
  openOpeningMinor: z.int(),
  unmatchedMinor: z.int(),
  recentSince: z.string(),
  recentSettlements: z.array(
    z.object({
      settlementId: z.int(),
      date: z.string(),
      amountMinor: z.int(),
      originalAmountMinor: z.int().nullable(),
      originalCurrency: z.string().nullable(),
      fxRate: z.string().nullable(),
      note: z.string().nullable(),
      items: z.array(StatementEntry.extend({ paidMinor: z.int() })),
    }),
  ),
  balanceMinor: z.int(),
  /** Every split item, oldest first. */
  entries: z.array(StatementEntry),
  scope: StatementScope,
  scopeItems: z.array(StatementEntry),
  scopeRemainingMinor: z.int(),
  scopeDeltaMinor: z.int(),
  show: z.array(StatementFlag),
  /** "How to pay": the methods for this currency; empty when the option is off or nothing is due from them. */
  payment: z.array(StatementPayment),
  text: z.string(),
});
export type Statement = z.infer<typeof Statement>;

export const OpenItemsQuery = z.object({
  participantId: z.coerce.number().pipe(Id),
  currency: Currency,
});
export type OpenItemsQuery = z.infer<typeof OpenItemsQuery>;

export const OpenItem = z.object({
  transactionId: z.int(),
  date: z.string(),
  merchant: z.string(),
  totalMinor: z.int(),
  deltaMinor: z.int(),
  remainingMinor: z.int(),
  status: z.enum(["open", "partial"]),
  paidByThem: z.boolean(),
  sharedNote: z.string().nullable(),
});
export type OpenItem = z.infer<typeof OpenItem>;

export const OpenItemList = z.object({ items: z.array(OpenItem) });
export type OpenItemList = z.infer<typeof OpenItemList>;

export const SharedNoteBody = z.object({ sharedNote: z.string().max(500).nullable() });
export type SharedNoteBody = z.infer<typeof SharedNoteBody>;

export const SharedNote = z.object({ transactionId: z.int(), sharedNote: z.string().nullable() });
export type SharedNote = z.infer<typeof SharedNote>;

export const UnsplitSuggestion = z.object({
  transactionId: z.int(),
  occurredAt: z.string(),
  merchant: z.string(),
  amountMinor: z.int(),
  currency: CurrencyCode,
  categoryName: z.string().nullable(),
  reason: z.enum(["merchant_rule", "category"]),
  suggestedParticipantIds: z.array(z.int()),
});
export type UnsplitSuggestion = z.infer<typeof UnsplitSuggestion>;

export const SuggestionList = z.object({ suggestions: z.array(UnsplitSuggestion) });
export type SuggestionList = z.infer<typeof SuggestionList>;

export const UnsplitMonth = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  count: z.int().nonnegative(),
  /** Per currency; never summed across currencies. amountMinor = Σ −amount (positive = spent). */
  totals: z.array(z.object({ currency: CurrencyCode, count: z.int().nonnegative(), amountMinor: z.int() })),
  /** Rows with a split suggestion (merchant rule or the category's learned set). */
  suggestedCount: z.int().nonnegative(),
});
export type UnsplitMonth = z.infer<typeof UnsplitMonth>;

export const UnsplitSummary = z.object({ months: z.array(UnsplitMonth) });
export type UnsplitSummary = z.infer<typeof UnsplitSummary>;

export const MerchantRule = z.object({
  merchant: z.string(),
  categoryId: z.int().nullable(),
  categoryName: z.string().nullable(),
  participants: z.array(z.object({ id: z.int(), name: z.string() })),
  autoSplit: z.boolean(),
  rowCount: z.int().nonnegative(),
  /** Rows the "split the existing ones too" action would split now. */
  unsplitCount: z.int().nonnegative(),
});
export type MerchantRule = z.infer<typeof MerchantRule>;

export const MerchantRuleList = z.object({ rules: z.array(MerchantRule) });
export type MerchantRuleList = z.infer<typeof MerchantRuleList>;

export const SetAutoSplitBody = z.object({
  merchant: z.string().trim().min(1),
  participantIds: z.array(Id),
  enabled: z.boolean(),
});
export type SetAutoSplitBody = z.infer<typeof SetAutoSplitBody>;

export const ApplyAutoSplitBody = z.object({ merchant: z.string().trim().min(1) });
export type ApplyAutoSplitBody = z.infer<typeof ApplyAutoSplitBody>;

export const ApplyAutoSplitResult = z.object({ merchant: z.string(), split: z.int().nonnegative() });
export type ApplyAutoSplitResult = z.infer<typeof ApplyAutoSplitResult>;
