import { describe, expect, it } from "vitest";
import { BatchSummary, ImportPreview } from "./import";

const preview = {
  source: "alipay",
  fileName: "a.csv",
  fileHash: "a".repeat(64),
  alreadyImported: false,
  existingBatchId: null,
  periodStart: null,
  periodEnd: null,
  rowsTotal: 1,
  newCount: 1,
  dupCount: 0,
  linkCount: 0,
  closedCount: 0,
  reconciliation: {
    ok: true,
    count: { declared: 1, parsed: 1, ok: true },
    buckets: [{ bucket: "expense", declared: { count: 1, minor: 100 }, parsed: { count: 1, minor: 100 }, ok: true }],
  },
  spending: [{ currency: "CNY", count: 1, spendingMinor: 100 }],
  accountsToCreate: [{ name: "支付宝余额", kind: "wallet", institution: "支付宝", last4: null, currency: "CNY" }],
  participantSuggestions: [],
  autoSplit: 0,
  warnings: [],
};

describe("import contracts", () => {
  it("accepts a well-formed preview", () => {
    expect(ImportPreview.parse(preview)).toEqual(preview);
  });

  it("rejects float money and unknown sources", () => {
    expect(ImportPreview.safeParse({ ...preview, spending: [{ currency: "CNY", count: 1, spendingMinor: 1.5 }] }).success).toBe(false);
    expect(ImportPreview.safeParse({ ...preview, source: "bank" }).success).toBe(false);
  });

  it("accepts a batch with null totals", () => {
    const b = {
      id: 1,
      source: "wechat",
      fileName: "w.xlsx",
      fileHash: "f",
      rowsTotal: 0,
      rowsInserted: 0,
      rowsSkippedDup: 0,
      rowsLinked: 0,
      declared: null,
      parsed: { count: 0 },
      status: "reverted",
      createdAt: "2026-09-29T00:00:00.000Z",
      revertedAt: "2026-09-29T00:00:01.000Z",
    };
    expect(BatchSummary.parse(b)).toEqual(b);
  });
});
