import { type CaptureReview, captures, type CaptureState, transactions } from "@yomi/db";
import { type IcbcSms, looksLikeIcbcSms, type NormalizedRow, parseIcbcSms } from "@yomi/importers";
import { and, eq } from "@yomi/db/orm";
import { runMatching } from "../capture/match";
import { ensureAccount, resolveAccountSpec } from "../import/accounts";
import { resolveCategoryId } from "../import/categorize";
import { categoryContext, latestPurchaseCategories, loadCategorySources } from "../import/category-context";
import { sha256Hex } from "../import/dedup";
import { cleanMerchant } from "../import/merchant";
import { myShareMinor } from "../ledger/share";
import { type Q, SplitError } from "../split/internal";
import { autoSplitParticipants } from "../split/rules";
import { applySplit, getSplit, setSplit, type SplitMode, type SplitView } from "../split/splits";
import { getTimeZone } from "../settings/time-zone";
import { occurredOnFor } from "../time/zone";
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

export interface SmsEntryResult {
  transactionId: number;
  split: SplitView | null;
  myShareMinor: number;
  /** The same alert was pasted before; nothing was written. */
  alreadyAdded: boolean;
  /** The statement (or wallet) row this alert duplicates; the new row is kept but not counted. */
  duplicateOfId: number | null;
  captureId: number;
  /** provisional until a statement row supersedes (or, for a split row, confirms) it. */
  state: CaptureState;
  /** An open review the alert landed in (two statement rows fit it, or one nearly does). */
  review: CaptureReview | null;
}

async function categoryFor(q: Q, user: CurrentUser, row: NormalizedRow, merchant: string): Promise<number | null> {
  // resolveCategoryId is synchronous: a refund's purchase category is looked up first.
  const inherited = row.kind === "refund" ? await latestPurchaseCategories(q, user, [merchant]) : new Map<string, number | null>();
  return resolveCategoryId(row, merchant, categoryContext(await loadCategorySources(q, user), (m) => inherited.get(m) ?? null));
}

/**
 * Saves a pasted ICBC card alert as a provisional transaction (source `sms`, the "auto" entries) on the card's
 * account, with its capture. Idempotent by dedup key. Participants split it like quick add; without them the
 * merchant's auto-split rule applies. Then the matcher runs: when exactly one statement (or Alipay/WeChat) row
 * already in the ledger is this charge, it supersedes the alert at once (a split alert stays primary and takes the
 * statement's facts); ties and near misses go to the review queue. A hold (预授权) is marked and not counted.
 */
export async function createSmsEntry(db: Q, user: CurrentUser, input: SmsEntryInput): Promise<SmsEntryResult> {
  const sms = parseIcbcSms(input.text, { today: input.today });
  if (!sms) {
    throw new SplitError("invalid", "quick_sms_unsupported", "This bank message is not a supported ICBC card alert");
  }
  const dedupKey = smsDedupKey(sms);
  return await db.transaction(async (q) => {
    const existing = (await q
      .select({ id: captures.id, transactionId: transactions.id, duplicateOfId: transactions.duplicateOfId, state: captures.state, review: captures.review })
      .from(captures)
      .innerJoin(transactions, eq(transactions.id, captures.transactionId))
      .where(and(eq(captures.userId, user.id), eq(captures.dedupKey, dedupKey)))
      .limit(1))[0];
    if (existing) {
      const { id: captureId, ...rest } = existing;
      return { ...rest, captureId, split: null, myShareMinor: 0, alreadyAdded: true };
    }

    const row = smsToRow(sms);
    const merchant = cleanMerchant(sms.merchant);
    const inserted = (await q
      .insert(transactions)
      .values({
        userId: user.id,
        accountId: await ensureAccount(q, user, resolveAccountSpec(row, row.currency)),
        occurredAt: row.occurredAt,
        occurredOn: occurredOnFor(row.occurredAt, "sms", await getTimeZone(q, user)),
        amountMinor: row.amountMinor,
        currency: row.currency,
        kind: row.kind,
        counterpartyRaw: row.counterparty,
        descriptionRaw: row.description,
        merchant,
        categoryId: await categoryFor(q, user, row, merchant),
        source: "sms",
        sourceCategory: row.sourceCategory,
        paymentMethod: row.paymentMethod,
        raw: row.raw,
        dedupKey,
        status: "ok",
        provisional: sms.hold ? "hold" : "capture",
      })
      .returning({ id: transactions.id })
      )[0]!;
    const captureId = (await q
      .insert(captures)
      .values({
        userId: user.id,
        kind: "sms",
        state: "provisional",
        dedupKey,
        transactionId: inserted.id,
        occurredAt: sms.occurredAt,
        amountMinor: sms.amountMinor,
        currency: sms.currency,
        last4: sms.last4,
        hold: sms.hold,
        payload: { v: 1, text: sms.text, history: [{ at: new Date().toISOString(), from: null, to: "provisional", by: "user" }] },
      })
      .returning({ id: captures.id }))[0]!.id;

    // Split first: a split alert is the user's record, so a statement row found next confirms it instead of replacing it.
    let split: SplitView | null = null;
    if (row.kind === "expense") {
      const others = input.participantIds ?? [];
      if (others.length > 0) {
        split = await setSplit(q, user, inserted.id, { participantIds: others, mode: input.mode ?? "equal" });
      } else if (!sms.hold) {
        // A hold's amount is not final yet: no automatic split.
        const auto = merchant ? (await autoSplitParticipants(q, user)).get(merchant) : undefined;
        if (auto) split = await applySplit(q, user, inserted.id, { participantIds: auto, mode: "equal" }, { markEdited: false, rememberMerchant: false });
      }
    }
    await runMatching(q, user, { by: "user", newCaptureIds: [captureId] });

    const after = (await q.select().from(transactions).where(eq(transactions.id, inserted.id)).limit(1))[0]!;
    const capture = (await q.select({ state: captures.state, review: captures.review }).from(captures).where(eq(captures.id, captureId)).limit(1))[0]!;
    if (split) split = await getSplit(q, user, inserted.id);
    return {
      transactionId: inserted.id,
      split,
      myShareMinor: myShareMinor(after, split?.rows ?? []),
      alreadyAdded: false,
      duplicateOfId: after.duplicateOfId,
      captureId,
      state: capture.state,
      review: capture.review,
    };
  });
}
