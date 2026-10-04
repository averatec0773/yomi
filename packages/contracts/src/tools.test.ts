import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TransactionQuery } from "./ledger";
import { AnalysisToolInput, IncomeSummaryToolInput, InvestOverviewToolInput, NetWorthToolInput, NoToolInput, StatementToolInput, TransactionsToolInput } from "./tools";

describe("tool input schemas", () => {
  it("each converts to a JSON Schema object", () => {
    for (const s of [TransactionsToolInput, AnalysisToolInput, IncomeSummaryToolInput, NetWorthToolInput, InvestOverviewToolInput, StatementToolInput, NoToolInput]) {
      expect(z.toJSONSchema(s, { io: "input" })).toMatchObject({ type: "object" });
    }
  });

  it("take JSON values the query-string schemas refuse, with small default pages", () => {
    expect(TransactionQuery.safeParse({ uncategorized: true }).success).toBe(false);
    expect(TransactionsToolInput.parse({ uncategorized: true, categoryId: 3 })).toEqual({ uncategorized: true, categoryId: 3, limit: 50, offset: 0 });
    expect(TransactionsToolInput.safeParse({ limit: 500 }).success).toBe(false);
    expect(StatementToolInput.parse({ participantId: 2, currency: " cny ", items: [5, 7], show: ["names"] })).toEqual({
      participantId: 2,
      currency: "CNY",
      items: [5, 7],
      show: ["names"],
    });
  });

  it("share the strict leaves: real dates, months and positive ids", () => {
    expect(AnalysisToolInput.safeParse({ period: "day", date: "2026-02-30" }).success).toBe(false);
    expect(TransactionsToolInput.safeParse({ month: "2026-13" }).success).toBe(false);
    expect(StatementToolInput.safeParse({ participantId: 0, currency: "CNY" }).success).toBe(false);
  });
});
