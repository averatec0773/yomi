import { type IcbcSms, looksLikeIcbcSms, type NormalizedRow, parseIcbcSms } from "@yomi/importers";
import { type CaptureResult, createCapture } from "../capture/create";
import { sha256Hex } from "../import/dedup";
import { type Q, SplitError } from "../split/internal";
import type { SplitMode } from "../split/splits";
import type { CurrentUser } from "../user";

export { looksLikeIcbcSms, parseIcbcSms };

/**
 * `sms:` + sha256(last4|datetime|amount|currency|merchant): pasting the same alert twice finds the first row. A hold
 * keys on its summary (预授权额度冻结), the merchant earlier versions read it as, so holds pasted before still match.
 */
export function smsDedupKey(sms: IcbcSms): string {
  const merchant = sms.hold ? `${sms.summary}${sms.merchant}` : sms.merchant;
  return `sms:${sha256Hex([sms.last4, sms.occurredAt, String(sms.amountMinor), sms.currency, merchant].join("|"))}`;
}

/** The row an alert becomes; the account and categorization code read it like an imported statement row. */
export function smsToRow(sms: IcbcSms): NormalizedRow {
  return {
    source: "sms",
    lineNo: 1,
    externalId: null,
    occurredAt: sms.occurredAt,
    amountMinor: sms.amountMinor,
    currency: sms.currency,
    originalAmountMinor: null,
    originalCurrency: null,
    direction: sms.direction,
    kind: sms.kind,
    status: "ok",
    counterparty: sms.merchant,
    description: sms.summary,
    sourceCategory: sms.summary || null,
    // Same payment method text as the ICBC PDF importer, so both land on the account 工商银行信用卡 <last4>.
    paymentMethod: `工商银行信用卡(${sms.last4})`,
    raw: {
      text: sms.text,
      channel: sms.channel,
      direction: sms.directionWord,
      summary: sms.summary,
      merchant: sms.merchant,
      city: sms.city ?? "",
    },
  };
}

export interface SmsEntryInput {
  text: string;
  /** 'YYYY-MM-DD'; picks the alert's year. */
  today: string;
  /** Non-self participants to split with (expenses only). */
  participantIds?: number[];
  mode?: SplitMode;
}

/**
 * Saves a pasted ICBC card alert as a capture (source `sms`, the "auto" entries) on the card's account: see
 * createCapture. A hold (预授权) is marked and not counted.
 */
export async function createSmsEntry(db: Q, user: CurrentUser, input: SmsEntryInput): Promise<CaptureResult> {
  const sms = parseIcbcSms(input.text, { today: input.today });
  if (!sms) {
    throw new SplitError("invalid", "quick_sms_unsupported", "This bank message is not a supported ICBC card alert");
  }
  return await createCapture(db, user, {
    kind: "sms",
    row: smsToRow(sms),
    dedupKey: smsDedupKey(sms),
    hold: sms.hold,
    last4: sms.last4,
    text: sms.text,
    participantIds: input.participantIds,
    mode: input.mode,
  });
}
