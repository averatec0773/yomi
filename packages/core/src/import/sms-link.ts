import { accounts, transactions, type Db } from "@yomi/db";
import { and, eq, inArray, isNull } from "@yomi/db/orm";
import { parsePaymentMethod } from "./accounts";

type Q = Db;

/** A pasted card alert and the statement row for the same charge are at most this many days apart. */
export const SMS_LINK_WINDOW_DAYS = 3;

function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

const CJK_RE = /[㐀-鿿豈-﫿]/;

function tokens(merchant: string): string[] {
  return merchant
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => (CJK_RE.test(t) ? t.length >= 2 : t.length >= 3 && !/^\d+$/.test(t)));
}

/**
 * Whether two merchant names can be the same shop: true when either is empty (nothing to compare), or they
 * share a word (3+ letters; Chinese names when one contains the other). `BUSY BEE BOBA` and `Busy Bee Boba
 * Houston` overlap; `Costco` and `Shell` do not.
 */
export function merchantsOverlap(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return true;
  return ta.some((x) => tb.some((y) => x === y || (CJK_RE.test(x) && CJK_RE.test(y) && (x.includes(y) || y.includes(x)))));
}

export interface CardCharge {
  last4: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  merchant: string;
}

/**
 * The closest row of `source` for the same card charge: same card last four (payment method or account),
 * amount and currency, ±3 days, overlapping merchant, not a duplicate itself and not yet the primary of a
 * row from `claimerSource`. `skip` holds ids already taken in this pass.
 */
export async function findCardMatch(
  q: Q,
  userId: number,
  charge: CardCharge,
  sources: readonly ("icbc_pdf" | "sms" | "alipay" | "wechat")[],
  claimerSource: "icbc_pdf" | "sms",
  skip: ReadonlySet<number> = new Set(),
): Promise<{ id: number; merchant: string; categoryId: number | null; userEditedAt: string | null } | null> {
  const day = dayNumber(charge.occurredAt);
  const near = (
    await q
      .select({
        id: transactions.id,
        occurredAt: transactions.occurredAt,
        merchant: transactions.merchant,
        categoryId: transactions.categoryId,
        userEditedAt: transactions.userEditedAt,
        paymentMethod: transactions.paymentMethod,
        accountLast4: accounts.last4,
      })
      .from(transactions)
      .leftJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.source, [...sources]),
          eq(transactions.currency, charge.currency),
          eq(transactions.amountMinor, charge.amountMinor),
          eq(transactions.status, "ok"),
          isNull(transactions.duplicateOfId),
        ),
      )
  )
    .filter((c) => {
      if (skip.has(c.id)) return false;
      if (Math.abs(dayNumber(c.occurredAt) - day) > SMS_LINK_WINDOW_DAYS) return false;
      if ((parsePaymentMethod(c.paymentMethod)?.last4 ?? c.accountLast4) !== charge.last4) return false;
      return merchantsOverlap(charge.merchant, c.merchant);
    })
    .sort((a, b) => Math.abs(dayNumber(a.occurredAt) - day) - Math.abs(dayNumber(b.occurredAt) - day) || a.id - b.id);
  for (const c of near) {
    const claimed = await q
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.duplicateOfId, c.id), eq(transactions.source, claimerSource)))
      .limit(1);
    if (!claimed[0]) return c;
  }
  return null;
}
