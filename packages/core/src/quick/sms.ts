import { accounts, categories, merchantRules, transactions } from "@yomi/db";
import { type IcbcSms, looksLikeIcbcSms, type NormalizedRow, parseIcbcSms } from "@yomi/importers";
import { and, desc, eq } from "@yomi/db/orm";
import { accountKey, resolveAccountSpec } from "../import/accounts";
import { resolveCategoryId } from "../import/categorize";
import { sha256Hex } from "../import/dedup";
import { cleanMerchant } from "../import/merchant";
import { findCardMatch } from "../import/sms-link";
import { type Q, SplitError } from "../split/internal";
import { autoSplitParticipants } from "../split/rules";
import { applySplit, setSplit, type SplitMode, type SplitView } from "../split/splits";
import { getTimeZone } from "../settings/time-zone";
import { occurredOnFor } from "../time/zone";
import type { CurrentUser } from "../user";

export { looksLikeIcbcSms, parseIcbcSms };

/** `sms:` + sha256(last4|datetime|amount|currency|merchant): pasting the same alert twice finds the first row. */
export function smsDedupKey(sms: IcbcSms): string {
  return `sms:${sha256Hex([sms.last4, sms.occurredAt, String(sms.amountMinor), sms.currency, sms.merchant].join("|"))}`;
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
}

async function categoryFor(q: Q, user: CurrentUser, row: NormalizedRow, merchant: string): Promise<number | null> {
  const cats = await q.select().from(categories).where(eq(categories.userId, user.id));
  // resolveCategoryId is synchronous and only asks about `merchant`: look its rule (and, for refunds, the
  // category of its latest purchase) up first.
  const ruleId = merchant
    ? ((
        await q
          .select({ categoryId: merchantRules.categoryId })
          .from(merchantRules)
          .where(and(eq(merchantRules.userId, user.id), eq(merchantRules.merchant, merchant)))
          .limit(1)
      )[0]?.categoryId ?? null)
    : null;
  const inheritedId =
    merchant && row.kind === "refund"
      ? ((
          await q
            .select({ categoryId: transactions.categoryId })
            .from(transactions)
            .where(and(eq(transactions.userId, user.id), eq(transactions.merchant, merchant), eq(transactions.kind, "expense")))
            .orderBy(desc(transactions.occurredAt), desc(transactions.id))
        ).find((r) => r.categoryId != null)?.categoryId ?? null)
      : null;
  const rule = (m: string) => (m === merchant ? ruleId : null);
  const inherited = (m: string) => (m === merchant ? inheritedId : null);
  return resolveCategoryId(row, merchant, {
    idByName: new Map(cats.map((c) => [c.name, c.id])),
    kindById: new Map(cats.map((c) => [c.id, c.kind])),
    ruleCategoryId: rule,
    inheritedCategoryId: inherited,
  });
}

async function accountIdFor(q: Q, user: CurrentUser, row: NormalizedRow): Promise<number> {
  const spec = resolveAccountSpec(row, row.currency);
  const key = accountKey(spec);
  const found = (await q
    .select()
    .from(accounts)
    .where(eq(accounts.userId, user.id))
    )
    .find((a) => accountKey(a) === key);
  if (found) return found.id;
  return (await q
    .insert(accounts)
    .values({ userId: user.id, ...spec })
    .returning({ id: accounts.id })
    )[0]!.id;
}

/**
 * Saves a pasted ICBC card alert as a transaction (source `sms`, the "auto" entries) on the card's account.
 * Idempotent by dedup key. When the monthly PDF row (or an Alipay/WeChat row paid with the card) is already
 * in the ledger, the new row points at it as a duplicate; otherwise it becomes the primary row and a later
 * PDF import links to it. Participants split it like quick add; without them the merchant's auto-split
 * rule applies.
 */
export async function createSmsEntry(db: Q, user: CurrentUser, input: SmsEntryInput): Promise<SmsEntryResult> {
  const sms = parseIcbcSms(input.text, { today: input.today });
  if (!sms) {
    throw new SplitError("invalid", "quick_sms_unsupported", "This bank message is not a supported ICBC card alert");
  }
  const dedupKey = smsDedupKey(sms);
  return await db.transaction(async (q) => {
    const existing = (await q
      .select({ id: transactions.id, duplicateOfId: transactions.duplicateOfId })
      .from(transactions)
      .where(and(eq(transactions.userId, user.id), eq(transactions.dedupKey, dedupKey)))
      .limit(1))[0];
    if (existing) {
      return { transactionId: existing.id, split: null, myShareMinor: 0, alreadyAdded: true, duplicateOfId: existing.duplicateOfId };
    }

    const row = smsToRow(sms);
    const merchant = cleanMerchant(sms.merchant);
    const charge = { last4: sms.last4, amountMinor: sms.amountMinor, currency: sms.currency, occurredAt: sms.occurredAt, merchant };
    const primary =
      await findCardMatch(q, user.id, charge, ["icbc_pdf"], "sms") ??
      // Wallet rows name the shop differently (often in Chinese), so only card, amount and date count there.
      await findCardMatch(q, user.id, { ...charge, merchant: "" }, ["alipay", "wechat"], "sms");

    const inserted = (await q
      .insert(transactions)
      .values({
        userId: user.id,
        accountId: await accountIdFor(q, user, row),
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
        duplicateOfId: primary?.id ?? null,
        status: "ok",
      })
      .returning({ id: transactions.id })
      )[0]!;

    let split: SplitView | null = null;
    if (!primary && row.kind === "expense") {
      const others = input.participantIds ?? [];
      if (others.length > 0) {
        split = await setSplit(q, user, inserted.id, { participantIds: others, mode: input.mode ?? "equal" });
      } else {
        const auto = merchant ? (await autoSplitParticipants(q, user)).get(merchant) : undefined;
        if (auto) split = await applySplit(q, user, inserted.id, { participantIds: auto, mode: "equal" }, { markEdited: false, rememberMerchant: false });
      }
    }
    const counted = primary ? 0 : -row.amountMinor;
    return {
      transactionId: inserted.id,
      split,
      myShareMinor: split?.myShareMinor ?? counted,
      alreadyAdded: false,
      duplicateOfId: primary?.id ?? null,
    };
  });
}
