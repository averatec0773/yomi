import { z } from "zod";
import { CurrencyCode } from "./common";
import { MonthString } from "./ledger";

export const CategoryShare = z.object({
  categoryId: z.int().nullable(),
  name: z.string(),
  minor: z.int(),
  count: z.int().nonnegative(),
  /** Basis points of the month's spending (10000 = 100%). */
  share: z.int(),
});

export const MonthCurrencyOverview = z.object({
  currency: CurrencyCode,
  spendingMinor: z.int(),
  incomeMinor: z.int(),
  transactionCount: z.int().nonnegative(),
  byCategory: z.array(CategoryShare),
  smallPayments: z.object({ thresholdMinor: z.int(), count: z.int().nonnegative(), minor: z.int() }),
  largest: z.array(z.object({ id: z.int(), merchant: z.string(), minor: z.int(), occurredAt: z.string(), occurredOn: z.string() })),
  previousMonthSpendingMinor: z.int().nullable(),
  dailyAverageMinor: z.int(),
  /** Money I fronted for others on shared rows I paid. */
  sharedReceivableMinor: z.int(),
  target: z
    .object({ amountMinor: z.int(), currency: CurrencyCode, remainingMinor: z.int(), monthSpecific: z.boolean() })
    .nullable(),
});
export type MonthCurrencyOverview = z.infer<typeof MonthCurrencyOverview>;

export const MonthOverview = z.object({
  month: MonthString,
  days: z.int().positive(),
  currencies: z.array(MonthCurrencyOverview),
});
export type MonthOverview = z.infer<typeof MonthOverview>;

/** PUT /api/targets body; month null sets the default target. */
export const SetTargetInput = z
  .object({ month: MonthString.nullable(), amountMinor: z.int().nonnegative(), currency: CurrencyCode })
  .strict();
export type SetTargetInput = z.infer<typeof SetTargetInput>;

export const Target = z.object({
  id: z.int(),
  month: MonthString.nullable(),
  amountMinor: z.int().nonnegative(),
  currency: CurrencyCode,
});
export type Target = z.infer<typeof Target>;
