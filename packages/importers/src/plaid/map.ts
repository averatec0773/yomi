import { ParseError } from "../errors";
import type { NormalizedRow } from "../types";
import type { PlaidAccount, PlaidTransaction } from "./types";

/**
 * Plaid gives dates only (no time, no zone). Rows are stored at noon US Eastern standard time so the
 * calendar day survives any conversion between US zones and UTC; the time of day is not real.
 */
export const PLAID_TIME_SUFFIX = "T12:00:00-05:00";

const REFUND_RE = /REFUND|RETURN|REVERSAL|CREDIT\s*ADJ/i;

/**
 * Plaid `amount` (JSON number, positive = money out of the account) → ledger minor units
 * (negative = money leaving me). One Math.round(amount * 100) is exact for values with at most
 * two decimals: such a value is the nearest double to the decimal, so ×100 lands within a few ulps
 * of the integer (far below 0.5 for any amount under 2^53 / 100). USD and every Plaid US currency
 * have two decimals.
 */
export function plaidAmountToMinor(amount: number): number {
  if (!Number.isFinite(amount)) throw new ParseError("import_bad_amount", `Invalid amount: ${amount}`, { value: String(amount) });
  const minor = -Math.round(amount * 100);
  return minor === 0 ? 0 : minor; // no -0
}

/** "PRIMARY/DETAILED" as stored in sourceCategory, or null. */
export function plaidSourceCategory(t: Pick<PlaidTransaction, "personal_finance_category">): string | null {
  const pfc = t.personal_finance_category;
  if (!pfc?.primary) return null;
  return pfc.detailed ? `${pfc.primary}/${pfc.detailed}` : pfc.primary;
}

/**
 * Kind from Plaid's personal_finance_category and the direction of money.
 * - Credit card bill payments (LOAN_PAYMENTS_CREDIT_CARD_PAYMENT, both sides) and TRANSFER_IN /
 *   TRANSFER_OUT are transfers, except the *_FROM_APPS details (Zelle, Venmo, Cash App): those are
 *   usually friends paying me back, which the split screen needs to see as income / expense.
 * - INCOME with money in is income.
 * - Other money in is a refund on a card, or on a bank account when a merchant is named or the text
 *   says refund; otherwise income. Everything else is an expense.
 */
export function plaidKind(account: Pick<PlaidAccount, "type"> | undefined, t: PlaidTransaction, amountMinor: number): NormalizedRow["kind"] {
  const primary = t.personal_finance_category?.primary ?? "";
  const detailed = t.personal_finance_category?.detailed ?? "";
  if (detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return "transfer";
  if ((primary === "TRANSFER_IN" || primary === "TRANSFER_OUT") && !detailed.endsWith("_FROM_APPS")) return "transfer";
  if (amountMinor > 0) {
    if (primary === "INCOME") return "income";
    if (account?.type === "credit" || t.merchant_name || REFUND_RE.test(t.name)) return "refund";
    return "income";
  }
  return "expense";
}

/** Payment method label; also how the UI names the account. */
export function plaidPaymentMethod(institutionName: string | null, account: Pick<PlaidAccount, "name" | "mask"> | undefined): string | null {
  const parts = [institutionName?.trim() || null, account?.name?.trim() || null].filter(Boolean).join(" ");
  if (!account) return parts || null;
  return account.mask ? `${parts} (${account.mask})` : parts || null;
}

/**
 * Plaid transactions (from /transactions/sync added or modified) → NormalizedRow[] with source
 * 'plaid'. Pending rows are skipped: when one posts, Plaid sends a new transaction_id (with
 * pending_transaction_id) and removes the pending one, so nothing needs reconciling.
 */
export function plaidToNormalizedRows(
  accounts: readonly PlaidAccount[],
  txns: readonly PlaidTransaction[],
  opts: { institutionName?: string | null } = {},
): NormalizedRow[] {
  const byId = new Map(accounts.map((a) => [a.account_id, a]));
  const rows: NormalizedRow[] = [];
  for (const t of txns) {
    if (t.pending) continue;
    const account = byId.get(t.account_id);
    const amountMinor = plaidAmountToMinor(t.amount);
    const kind = plaidKind(account, t, amountMinor);
    const currency = (
      t.iso_currency_code ??
      t.unofficial_currency_code ??
      account?.balances?.iso_currency_code ??
      account?.balances?.unofficial_currency_code ??
      "USD"
    ).toUpperCase();
    rows.push({
      source: "plaid",
      lineNo: rows.length + 1,
      externalId: t.transaction_id,
      occurredAt: `${t.authorized_date ?? t.date}${PLAID_TIME_SUFFIX}`,
      amountMinor,
      currency,
      originalAmountMinor: null,
      originalCurrency: null,
      direction: kind === "transfer" ? "neutral" : amountMinor < 0 ? "out" : "in",
      kind,
      status: "ok",
      counterparty: t.merchant_name?.trim() || t.name,
      description: t.name,
      sourceCategory: plaidSourceCategory(t),
      paymentMethod: plaidPaymentMethod(opts.institutionName ?? null, account),
      raw: {
        transaction_id: t.transaction_id,
        account_id: t.account_id,
        amount: String(t.amount),
        iso_currency_code: t.iso_currency_code ?? "",
        unofficial_currency_code: t.unofficial_currency_code ?? "",
        date: t.date,
        authorized_date: t.authorized_date ?? "",
        name: t.name,
        merchant_name: t.merchant_name ?? "",
        pending_transaction_id: t.pending_transaction_id ?? "",
        pfc_primary: t.personal_finance_category?.primary ?? "",
        pfc_detailed: t.personal_finance_category?.detailed ?? "",
        payment_channel: t.payment_channel ?? "",
      },
    });
  }
  return rows;
}
