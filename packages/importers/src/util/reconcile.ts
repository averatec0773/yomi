import type { DeclaredTotals, NormalizedRow } from "../types";

const BUCKET = { out: "expense", in: "income", neutral: "neutral" } as const;

/**
 * Parsed totals on the same basis as the file's own summary (bucket = the file's 收/支 column,
 * i.e. `direction`). Observed on the real Alipay export: a bucket's count includes 交易关闭 rows
 * but its amount excludes them, so closed rows add to `count` only.
 */
export function bucketTotals(rows: readonly NormalizedRow[]): DeclaredTotals {
  const out: DeclaredTotals = { count: rows.length };
  for (const row of rows) {
    const key = BUCKET[row.direction];
    const b = (out[key] ??= { count: 0, minor: 0 });
    b.count++;
    if (row.status === "ok") b.minor += Math.abs(row.amountMinor);
  }
  return out;
}
