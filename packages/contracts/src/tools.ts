import { z } from "zod";
import { AnalysisPreset, PeriodKind } from "./analysis";
import { NetWorthRange } from "./assets";
import { Currency, DateString, Id, Locale, MonthString } from "./common";
import { TransactionKind } from "./ledger";
import { StatementFlag, StatementScope } from "./split";

// Inputs of the reads the MCP endpoint will expose: plain JSON objects (real booleans, numbers and arrays, no
// query-string coercion or comma lists) built from the shared leaves, so each converts to a JSON Schema. The HTTP
// routes keep their query-string schemas; both shapes reach the same core function.

/** A page of transactions (core transactionPage) in a month or range; pages are smaller than the UI's. */
export const TransactionsToolInput = z.object({
  month: MonthString.optional(),
  from: DateString.optional(),
  to: DateString.optional(),
  q: z.string().max(200).optional(),
  categoryId: Id.optional(),
  participantId: Id.optional(),
  kind: TransactionKind.optional(),
  uncategorized: z.boolean().optional(),
  unsplit: z.boolean().optional(),
  limit: z.int().min(1).max(200).default(50),
  offset: z.int().min(0).default(0),
});
export type TransactionsToolInput = z.infer<typeof TransactionsToolInput>;

/** The Analysis report (core analysisFor): one of a period kind (with a date), a preset or a range; this month without. */
export const AnalysisToolInput = z.object({
  period: PeriodKind.optional(),
  date: DateString.optional(),
  preset: AnalysisPreset.optional(),
  from: DateString.optional(),
  to: DateString.optional(),
});
export type AnalysisToolInput = z.infer<typeof AnalysisToolInput>;

/** Net worth (core netWorth) on a day, over a range, optionally totalled in one currency. */
export const NetWorthToolInput = z.object({ asOf: DateString.optional(), range: NetWorthRange.optional(), currency: Currency.optional() });
export type NetWorthToolInput = z.infer<typeof NetWorthToolInput>;

/** Holdings (core investOverview) on a day, optionally totalled in one currency. */
export const InvestOverviewToolInput = z.object({ asOf: DateString.optional(), currency: Currency.optional() });
export type InvestOverviewToolInput = z.infer<typeof InvestOverviewToolInput>;

/** The statement for one friend in one currency (core statementText). */
export const StatementToolInput = z.object({
  participantId: Id,
  currency: Currency,
  since: DateString.optional(),
  locale: Locale.optional(),
  scope: StatementScope.optional(),
  /** Transaction ids, for scope "selected" only. */
  items: z.array(Id).min(1).max(2000).optional(),
  show: z.array(StatementFlag).optional(),
});
export type StatementToolInput = z.infer<typeof StatementToolInput>;

/** Reads that take no input: balances with friends, data freshness, the capture review queue. */
export const NoToolInput = z.object({});
