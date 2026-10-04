import { z } from "zod";
import { CaptureState } from "./capture";
import { Currency, CurrencyCode, DateString, Id, MessageParams } from "./common";
import { CreatedEntry, SplitMode } from "./split";

export const QuickParseBody = z.object({
  text: z.string().min(1),
  /** Optional overrides; the server defaults to today in the user's time zone and CNY. */
  today: DateString.optional(),
  defaultCurrency: CurrencyCode.optional(),
});
export type QuickParseBody = z.infer<typeof QuickParseBody>;

export const QuickError = z.object({
  code: z.enum([
    "quick_missing_amount",
    "quick_amount_not_positive",
    "quick_invalid_amount",
    "quick_invalid_date",
    "quick_unknown_participant",
    "quick_treat",
    "quick_sms_unsupported",
  ]),
  message: z.string(),
  params: MessageParams,
  name: z.string().optional(),
});

/** A pasted ICBC card alert, as the quick-add preview shows it. */
export const QuickSms = z.object({
  bank: z.literal("icbc"),
  last4: z.string().regex(/^\d{4}$/),
  /** ISO with +08:00 (Beijing time). */
  occurredAt: z.string(),
  /** Day of occurredAt in the user's time zone. */
  occurredOn: z.string(),
  merchant: z.string(),
  /** Signed minor units; negative = spending. */
  amountMinor: z.int(),
  currency: CurrencyCode,
  kind: z.enum(["expense", "income", "transfer", "refund"]),
  /** A card hold (预授权): saved as provisional and not counted until the statement row. */
  hold: z.boolean(),
});
export type QuickSms = z.infer<typeof QuickSms>;

export const QuickDraft = z.object({
  amountMinor: z.int().positive().nullable(),
  currency: CurrencyCode,
  description: z.string(),
  date: DateString,
  participantIds: z.array(z.int()),
  payerId: z.int().nullable(),
  mode: SplitMode,
  categoryHint: z.string().nullable(),
  errors: z.array(QuickError),
  sms: QuickSms.nullable().optional(),
});
export type QuickDraft = z.infer<typeof QuickDraft>;

/** What POST /api/quick accepts: a draft whose amount is set (errors are ignored). */
export const QuickCreateBody = QuickDraft.extend({
  amountMinor: z.int().positive(),
  currency: z.string().trim().toUpperCase().pipe(CurrencyCode),
  errors: z.array(QuickError).optional(),
  /** The pasted alert, re-parsed on the server when the draft came from one (the draft's sms is only a preview). */
  smsText: z.string().min(1).max(2000).optional(),
  today: DateString.optional(),
});
export type QuickCreateBody = z.infer<typeof QuickCreateBody>;

/** POST /api/quick: the created entry; for a pasted alert also whether it was there already or duplicates a statement row. */
export const QuickCreated = CreatedEntry.extend({
  alreadyAdded: z.boolean().optional(),
  duplicateOfId: z.int().nullable().optional(),
  /** A pasted alert: its capture, the capture's state, and the review it landed in (null when none). */
  captureId: z.int().optional(),
  state: CaptureState.optional(),
  review: z.enum(["ambiguous", "near_miss", "amount_changed"]).nullable().optional(),
});
export type QuickCreated = z.infer<typeof QuickCreated>;

/** One of my accounts as the quick-add income and transfer forms offer it. */
export const QuickAccount = z.object({ id: z.int(), name: z.string(), currency: CurrencyCode });
export type QuickAccount = z.infer<typeof QuickAccount>;

/** GET /api/quick/accounts. */
export const QuickAccountList = z.object({ accounts: z.array(QuickAccount) });
export type QuickAccountList = z.infer<typeof QuickAccountList>;

/** POST /api/quick/income: income typed by hand; `accountId` null books it on the manual cash account. */
export const QuickIncomeBody = z
  .object({
    amountMinor: z.int().positive(),
    currency: Currency,
    categoryId: Id,
    date: DateString,
    accountId: Id.nullable(),
    note: z.string().max(200).nullable().optional(),
  })
  .strict();
export type QuickIncomeBody = z.infer<typeof QuickIncomeBody>;

/** POST /api/quick/transfer: money moved between two of my accounts (same currency). */
export const QuickTransferBody = z
  .object({ fromAccountId: Id, toAccountId: Id, amountMinor: z.int().positive(), date: DateString })
  .strict();
export type QuickTransferBody = z.infer<typeof QuickTransferBody>;

/** POST /api/quick/income and /api/quick/transfer: the rows created (a transfer's outgoing leg first). */
export const QuickRowsCreated = z.object({ transactionIds: z.array(z.int()) });
export type QuickRowsCreated = z.infer<typeof QuickRowsCreated>;
