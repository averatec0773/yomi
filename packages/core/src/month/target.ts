import { type Db, monthlyTargets } from "@yomi/db";
import { and, eq, isNull } from "@yomi/db/orm";
import { LedgerError } from "../ledger/errors";
import { isMonth } from "../time/day";
import type { CurrentUser } from "../user";

export interface TargetItem {
  id: number;
  month: string | null;
  amountMinor: number;
  currency: string;
}

export interface MonthTarget {
  amountMinor: number;
  currency: string;
  /** Target minus spending; negative when over. */
  remainingMinor: number;
  /** True when this month has its own target, false when the default applies. */
  monthSpecific: boolean;
}

export function assertMonth(month: string) {
  if (!isMonth(month)) throw new LedgerError("invalid", "invalid_month", `Invalid month: ${month}`, { value: month });
}

/** Month-specific target if set, else the default (month null). */
export async function getMonthlyTarget(db: Db, user: CurrentUser, month: string): Promise<TargetItem | null> {
  assertMonth(month);
  const pick = async (m: string | null) =>
    (await db
      .select({ id: monthlyTargets.id, month: monthlyTargets.month, amountMinor: monthlyTargets.amountMinor, currency: monthlyTargets.currency })
      .from(monthlyTargets)
      .where(and(eq(monthlyTargets.userId, user.id), m == null ? isNull(monthlyTargets.month) : eq(monthlyTargets.month, m)))
      .limit(1))[0] ?? null;
  return await pick(month) ?? await pick(null);
}

/** Upserts the target for a month (or the default when month is null). */
export async function setMonthlyTarget(
  db: Db,
  user: CurrentUser,
  input: { month: string | null; amountMinor: number; currency: string },
): Promise<TargetItem> {
  const { month, amountMinor, currency } = input;
  if (month != null) assertMonth(month);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new LedgerError("invalid", "target_amount_invalid", "The target must be a non-negative integer (minor units)");
  if (!/^[A-Z]{3}$/.test(currency)) throw new LedgerError("invalid", "invalid_currency", `Invalid currency: ${currency}`, { value: currency });
  const where = and(eq(monthlyTargets.userId, user.id), month == null ? isNull(monthlyTargets.month) : eq(monthlyTargets.month, month));
  return await db.transaction(async (tx) => {
    const existing = (await tx.select({ id: monthlyTargets.id }).from(monthlyTargets).where(where).limit(1))[0];
    if (existing) {
      await tx.update(monthlyTargets).set({ amountMinor, currency }).where(eq(monthlyTargets.id, existing.id));
      return { id: existing.id, month, amountMinor, currency };
    }
    const row = (await tx.insert(monthlyTargets).values({ userId: user.id, month, amountMinor, currency }).returning({ id: monthlyTargets.id }))[0]!;
    return { id: row.id, month, amountMinor, currency };
  });
}
