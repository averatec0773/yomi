import type { DeclaredTotals } from "../types";
import { parseAmountMinor } from "./amount";
import { localTextToIso } from "./time";

type BucketLabel = "收入" | "支出" | "不计收支" | "中性交易";

const BUCKETS: Record<BucketLabel, keyof Omit<DeclaredTotals, "count">> = {
  收入: "income",
  支出: "expense",
  不计收支: "neutral",
  中性交易: "neutral",
};

/**
 * Reads the summary the export states above the header:
 * `共N笔记录`, `收入：N笔 X元`, `支出：N笔 X元`, `不计收支：N笔 X元` (Alipay) / `中性交易：N笔 X元` (WeChat),
 * and `起始时间：[..] 终止时间：[..]`.
 */
export function parsePreamble(lines: readonly string[]): {
  declared: DeclaredTotals;
  periodStart?: string;
  periodEnd?: string;
} {
  const declared: DeclaredTotals = {};
  let periodStart: string | undefined;
  let periodEnd: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    const total = /^共(\d+)笔记录/.exec(line);
    if (total) declared.count = Number(total[1]);
    const bucket = /^(收入|支出|不计收支|中性交易)[：:]\s*(\d+)笔\s*([\d,.]+)元/.exec(line);
    if (bucket) {
      declared[BUCKETS[bucket[1] as BucketLabel]] = {
        count: Number(bucket[2]),
        minor: parseAmountMinor(bucket[3]!),
      };
    }
    const period = /起始时间[：:]\[([^\]]+)\]\s*终止时间[：:]\[([^\]]+)\]/.exec(line);
    if (period) {
      periodStart = localTextToIso(period[1]!);
      periodEnd = localTextToIso(period[2]!);
    }
  }
  return { declared, periodStart, periodEnd };
}
