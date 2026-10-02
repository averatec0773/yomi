import { z } from "zod";
import { CurrencyCode } from "./common";
import { DateString, MonthString } from "./ledger";
import { RangeCurrencyOverview, StatsPreset } from "./stats";

export const PeriodKind = z.enum(["day", "week", "month", "year"]);
export type PeriodKind = z.infer<typeof PeriodKind>;

export const AnalysisPreset = z.enum(["yesterday", "today", "this_week", "last_week", ...StatsPreset.options]);
export type AnalysisPreset = z.infer<typeof AnalysisPreset>;

/**
 * GET /api/analysis query, one of: `?period=day|week|month|year[&date=YYYY-MM-DD]` (the period containing date;
 * without a date Day is yesterday and the others contain today: the form MCP tools use), `?preset=`, or `?from=&to=`
 * (inclusive, at most five years). Nothing given means this month. Weeks start on Monday.
 */
export const AnalysisQuery = z
  .object({
    period: PeriodKind.optional(),
    date: DateString.optional(),
    preset: AnalysisPreset.optional(),
    from: DateString.optional(),
    to: DateString.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const range = q.from !== undefined || q.to !== undefined;
    if (range && (q.from === undefined || q.to === undefined)) ctx.addIssue({ code: "custom", message: "from and to go together" });
    if (q.date !== undefined && q.period === undefined) ctx.addIssue({ code: "custom", path: ["date"], message: "date needs period" });
    if ([q.period !== undefined, q.preset !== undefined, range].filter(Boolean).length > 1) {
      ctx.addIssue({ code: "custom", message: "use one of period, preset or from/to" });
    }
    if (q.from !== undefined && q.to !== undefined && q.from > q.to) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "the start date cannot be after the end date" });
    }
  });
export type AnalysisQuery = z.infer<typeof AnalysisQuery>;

const DateRange = z.object({ from: DateString, to: DateString });

export const Typical = z.object({ periods: z.int().positive(), perPeriodMinor: z.int(), dailyMinor: z.int() });
export type Typical = z.infer<typeof Typical>;

export const MerchantTotal = z.object({ merchant: z.string(), minor: z.int(), count: z.int().positive(), share: z.int() });
export type MerchantTotal = z.infer<typeof MerchantTotal>;

export const CategoryShift = z.object({
  categoryId: z.int().nullable(),
  name: z.string(),
  currentMinor: z.int(),
  typicalMinor: z.int(),
  deltaMinor: z.int(),
});
export type CategoryShift = z.infer<typeof CategoryShift>;

const UnusualBase = z.object({ id: z.int(), merchant: z.string(), minor: z.int(), occurredOn: DateString, source: z.string() });
export const UnusualItem = z.discriminatedUnion("kind", [
  UnusualBase.extend({ kind: z.literal("larger_than_usual"), usualMinor: z.int() }),
  UnusualBase.extend({ kind: z.literal("first_large") }),
  UnusualBase.extend({ kind: z.literal("possible_duplicate"), otherId: z.int(), otherSource: z.string() }),
]);
export type UnusualItem = z.infer<typeof UnusualItem>;

export const NewMerchant = z.object({ merchant: z.string(), minor: z.int(), count: z.int().positive(), firstOn: DateString });
export type NewMerchant = z.infer<typeof NewMerchant>;

export const DayRow = z.object({
  id: z.int(),
  merchant: z.string(),
  minor: z.int(),
  occurredAt: z.string(),
  occurredOn: DateString,
  source: z.string(),
  categoryId: z.int().nullable(),
});
export type DayRow = z.infer<typeof DayRow>;

export const AnalysisCurrency = RangeCurrencyOverview.extend({
  typical: Typical.nullable(),
  topMerchants: z.array(MerchantTotal),
  categoryShifts: z.array(CategoryShift),
  unusual: z.array(UnusualItem),
  newMerchants: z.array(NewMerchant),
  /** Keys of the sources that leave this currency's period incomplete; comparisons are hidden while any. */
  partialSources: z.array(z.string()),
  /** Day only. */
  dayRows: z.array(DayRow).nullable(),
});
export type AnalysisCurrency = z.infer<typeof AnalysisCurrency>;

export const InvestmentChange = z.object({
  currency: CurrencyCode,
  startMinor: z.int().nullable(),
  endMinor: z.int().nullable(),
  changeMinor: z.int().nullable(),
  netDepositsMinor: z.int(),
  marketMinor: z.int().nullable(),
  dividendCount: z.int().nonnegative(),
  partial: z.boolean(),
});
export type InvestmentChange = z.infer<typeof InvestmentChange>;

export const FreshnessSource = z.enum(["plaid", "alipay", "wechat", "icbc_pdf", "boa_csv", "sms", "ibkr", "plaid_investments"]);
export type FreshnessSource = z.infer<typeof FreshnessSource>;

export const SourceFreshness = z.object({
  key: z.string(),
  source: FreshnessSource,
  kind: z.enum(["stream", "export", "capture", "investments"]),
  label: z.string().nullable(),
  /** Last day the data is complete through. */
  through: DateString.nullable(),
  /** Captures: the last day something was captured. */
  lastOn: DateString.nullable(),
  status: z.enum(["active", "paused", "error", "waiting"]),
  errorCode: z.string().nullable(),
  expectedThrough: DateString.nullable(),
  currencies: z.array(CurrencyCode),
  state: z.enum(["current", "behind", "error", "paused", "never"]),
  exportReminder: z.boolean(),
});
export type SourceFreshness = z.infer<typeof SourceFreshness>;

/** One source's part of the period's summary numbers in one currency (linked duplicates count once, on the kept row). */
export const SourceTotal = z.object({
  /** A freshness key, or the ledger source for rows no listed source covers ("manual"). */
  key: z.string(),
  source: z.string(),
  currency: CurrencyCode,
  /** Rows counted as spending. */
  count: z.int().nonnegative(),
  /** My share of those rows. */
  spendingMinor: z.int(),
  incomeCount: z.int().nonnegative(),
  incomeMinor: z.int(),
});
export type SourceTotal = z.infer<typeof SourceTotal>;

export const Attention = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plaid"), key: z.string(), label: z.string().nullable(), errorCode: z.string().nullable() }),
  z.object({
    kind: z.literal("ibkr"),
    key: z.string(),
    state: z.enum(["error", "waiting"]),
    errorCode: z.string().nullable(),
    through: DateString.nullable(),
    expectedThrough: DateString.nullable(),
  }),
]);
export type Attention = z.infer<typeof Attention>;

/** GET /api/analysis response. */
export const AnalysisReport = z.object({
  kind: z.union([PeriodKind, z.literal("range")]),
  from: DateString,
  to: DateString,
  today: DateString,
  weekStart: z.int().min(0).max(6),
  inProgress: z.boolean(),
  future: z.boolean(),
  days: z.int().positive(),
  lengthDays: z.int().positive(),
  previous: z.object({ from: DateString, to: DateString, days: z.int().positive() }),
  month: MonthString.nullable(),
  typicalRanges: z.array(DateRange),
  currencies: z.array(AnalysisCurrency),
  partial: z.record(CurrencyCode, z.array(z.string())),
  arrivals: z.array(z.object({ source: z.string(), count: z.int().positive() })).nullable(),
  investments: z.array(InvestmentChange).nullable(),
  close: z.object({ marketDay: z.boolean(), previousClose: DateString }).nullable(),
  attention: z.array(Attention),
  freshness: z.array(SourceFreshness),
  sourceTotals: z.array(SourceTotal),
});
export type AnalysisReport = z.infer<typeof AnalysisReport>;

/** GET /api/analysis/freshness response. */
export const FreshnessResponse = z.object({ today: DateString, sources: z.array(SourceFreshness) });
export type FreshnessResponse = z.infer<typeof FreshnessResponse>;
