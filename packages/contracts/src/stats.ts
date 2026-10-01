import { z } from "zod";
import { CurrencyCode } from "./common";
import { DateString, MonthString } from "./ledger";
import { CategoryShare } from "./month";

export const StatsPreset = z.enum(["this_month", "last_month", "last_3_months", "last_6_months", "this_year", "last_year"]);
export type StatsPreset = z.infer<typeof StatsPreset>;

/**
 * GET /api/stats query: `?preset=` or `?from=&to=` (inclusive, at most five years; `preset=custom` is
 * allowed with them). Nothing given means this_month.
 */
export const StatsQuery = z
  .object({ preset: z.union([StatsPreset, z.literal("custom")]).optional(), from: DateString.optional(), to: DateString.optional() })
  .strict()
  .superRefine((q, ctx) => {
    const range = q.from !== undefined || q.to !== undefined;
    if (range && (q.from === undefined || q.to === undefined)) ctx.addIssue({ code: "custom", message: "from and to go together" });
    if (range && q.preset !== undefined && q.preset !== "custom") ctx.addIssue({ code: "custom", message: "use either preset or from/to" });
    if (q.preset === "custom" && !range) ctx.addIssue({ code: "custom", message: "preset=custom needs from and to" });
    if (q.from !== undefined && q.to !== undefined && q.from > q.to) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "the start date cannot be after the end date" });
    }
  });
export type StatsQuery = z.infer<typeof StatsQuery>;

export const PeriodMetrics = z.object({
  spendingMinor: z.int(),
  incomeMinor: z.int(),
  transactionCount: z.int().nonnegative(),
  dailyAverageMinor: z.int(),
});
export type PeriodMetrics = z.infer<typeof PeriodMetrics>;

export const RangeCurrencyOverview = PeriodMetrics.extend({
  currency: CurrencyCode,
  byCategory: z.array(CategoryShare),
  smallPayments: z.object({ thresholdMinor: z.int(), count: z.int().nonnegative(), minor: z.int() }),
  largest: z.array(z.object({ id: z.int(), merchant: z.string(), minor: z.int(), occurredAt: z.string(), occurredOn: z.string() })),
  sharedReceivableMinor: z.int(),
  /** Same metrics over the previous period of equal length; null when it has no spending rows. */
  previous: PeriodMetrics.nullable(),
  /** Spending per calendar month; null when the range sits inside one month. */
  monthly: z.array(z.object({ month: MonthString, spendingMinor: z.int(), partial: z.boolean() })).nullable(),
  target: z
    .object({ amountMinor: z.int(), currency: CurrencyCode, remainingMinor: z.int(), monthSpecific: z.boolean() })
    .nullable(),
});
export type RangeCurrencyOverview = z.infer<typeof RangeCurrencyOverview>;

export const RangeOverview = z.object({
  from: DateString,
  to: DateString,
  days: z.int().positive(),
  lengthDays: z.int().positive(),
  inProgress: z.boolean(),
  previous: z.object({ from: DateString, to: DateString, days: z.int().positive() }),
  month: MonthString.nullable(),
  currencies: z.array(RangeCurrencyOverview),
});
export type RangeOverview = z.infer<typeof RangeOverview>;

/** GET /api/stats response: the resolved preset ("custom" when the range matches none) plus the overview. */
export const StatsResponse = RangeOverview.extend({ preset: z.union([StatsPreset, z.literal("custom")]) });
export type StatsResponse = z.infer<typeof StatsResponse>;
