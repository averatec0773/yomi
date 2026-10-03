import { z } from "zod";
import { CurrencyCode, MonthString } from "./common";

export const CategoryShare = z.object({
  categoryId: z.int().nullable(),
  name: z.string(),
  minor: z.int(),
  count: z.int().nonnegative(),
  /** Basis points of the month's spending (10000 = 100%). */
  share: z.int(),
});

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
