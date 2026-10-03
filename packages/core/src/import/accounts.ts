import { accounts, type Db } from "@yomi/db";
import { BOA_CARD_METHOD, type NormalizedRow, type SourceId } from "@yomi/importers";
import { asc, eq } from "@yomi/db/orm";
import type { CurrentUser } from "../user";

export type AccountKind = "wallet" | "debit_card" | "credit_card";

export interface AccountSpec {
  name: string;
  kind: AccountKind;
  institution: string | null;
  last4: string | null;
  currency: string;
}

export interface ParsedCard {
  institution: string;
  cardType: string;
  kind: AccountKind;
  last4: string;
}

const CARD_RE = /^(.+?)(储蓄卡|借记卡|信用卡)\s*[(（]\s*(\d{4})\s*[)）]$/;

/** `工商银行信用卡(7702)&工商银行立减金` → { institution: 工商银行, cardType: 信用卡, last4: 7702 }. */
export function parsePaymentMethod(paymentMethod: string | null | undefined): ParsedCard | null {
  if (!paymentMethod) return null;
  const head = (paymentMethod.split("&")[0] ?? "").trim();
  const m = CARD_RE.exec(head);
  if (!m) return null;
  const [, institution, cardType, last4] = m as unknown as [string, string, string, string];
  return {
    institution: institution.trim(),
    cardType,
    kind: cardType === "信用卡" ? "credit_card" : "debit_card",
    last4,
  };
}

const WALLETS: Record<SourceId, Omit<AccountSpec, "currency">> = {
  alipay: { name: "支付宝余额", kind: "wallet", institution: "支付宝", last4: null },
  wechat: { name: "微信零钱", kind: "wallet", institution: "微信", last4: null },
  icbc_pdf: { name: "工商银行信用卡", kind: "credit_card", institution: "工商银行", last4: null },
  // Only a fallback: bank sync always passes the connected account explicitly.
  plaid: { name: "银行同步账户", kind: "debit_card", institution: null, last4: null },
  // The BoA CSV carries no account number; the credit card variant is told apart by its payment method.
  boa_csv: { name: "Bank of America 支票", kind: "debit_card", institution: "Bank of America", last4: null },
  // Only a fallback: an SMS row always names its card, so resolveAccountSpec takes the card branch.
  sms: { name: "工商银行信用卡", kind: "credit_card", institution: "工商银行", last4: null },
};

const BOA_CARD: Omit<AccountSpec, "currency"> = { name: "Bank of America 信用卡", kind: "credit_card", institution: "Bank of America", last4: null };

/** Default currency of accounts created from a file: CNY for Chinese wallets/cards, first row currency for ICBC PDF, USD for BoA. */
export function fileAccountCurrency(source: SourceId, rows: readonly NormalizedRow[]): string {
  if (source === "icbc_pdf") return rows[0]?.currency ?? "USD";
  if (source === "boa_csv") return "USD";
  return "CNY";
}

export function resolveAccountSpec(row: NormalizedRow, currency: string): AccountSpec {
  const card = parsePaymentMethod(row.paymentMethod);
  if (card) {
    return {
      name: `${card.institution}${card.cardType} ${card.last4}`,
      kind: card.kind,
      institution: card.institution,
      last4: card.last4,
      currency,
    };
  }
  if (row.source === "boa_csv" && row.paymentMethod === BOA_CARD_METHOD) return { ...BOA_CARD, currency };
  return { ...WALLETS[row.source], currency };
}

/** A spec's full identity, the table's unique (kind, institution, last4, name); dedup keys are scoped by it. */
export function accountKey(a: { kind: string; institution: string | null; last4: string | null; name: string }): string {
  return [a.kind, a.institution ?? "", a.last4 ?? "", a.name].join("|");
}

/**
 * Which ledger account a spec means: the same kind, institution and last four. The name is a label, so a card that
 * Alipay calls 储蓄卡, WeChat 借记卡 and bank sync "Debit 1234" is one account, not three.
 */
export function accountMatchKey(a: { kind: string; institution: string | null; last4: string | null }): string {
  return [a.kind, a.institution ?? "", a.last4 ?? ""].join("|");
}

/** The user's account id per match key; the oldest wins where earlier versions created several. */
export async function loadAccountIds(q: Db, user: CurrentUser): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const a of await q.select().from(accounts).where(eq(accounts.userId, user.id)).orderBy(asc(accounts.id))) {
    const key = accountMatchKey(a);
    if (!out.has(key)) out.set(key, a.id);
  }
  return out;
}

/** The ledger account for `spec`, created when none matches. Import, SMS capture and bank sync all resolve accounts by this rule. */
export async function ensureAccount(q: Db, user: CurrentUser, spec: AccountSpec): Promise<number> {
  const found = (await loadAccountIds(q, user)).get(accountMatchKey(spec));
  if (found != null) return found;
  return (await q.insert(accounts).values({ userId: user.id, ...spec }).returning({ id: accounts.id }))[0]!.id;
}

export type AccountRow = typeof accounts.$inferSelect;
