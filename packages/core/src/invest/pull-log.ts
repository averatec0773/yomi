import type { FlexRetry } from "@yomi/importers";

/** What started an IBKR Flex pull: Test connection, the scheduler, Sync now, Pull history, or `pnpm invest:sync`. */
export type IbkrPullKind = "test" | "scheduled" | "sync" | "history" | "cli";

/** One IBKR Flex pull, for its server log line. Holds no token, query ID or amount. */
export interface FlexPullLog {
  kind: IbkrPullKind;
  /** The `fd`/`td` asked for; null when the query's saved period applied. */
  range: { from: string; to: string } | null;
  retries: readonly FlexRetry[];
  /** The `to` of the weekday-earlier retry after 1003/1020, with the code that caused it; null when it did not run. */
  fallback: { to: string; code: string } | null;
  /** Statement date received (Flex toDate); null when the pull failed. */
  statementDate: string | null;
  /** Section ids the statement had; null when the pull failed or the source did not report them. */
  sections: readonly string[] | null;
  /** Stable code (and IBKR's ErrorCode) of a failed pull. */
  error: { code: string; flexCode: string | null } | null;
  ms: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * `[yomi] IBKR Flex pull (test): asked 2026-09-29..2026-09-29; retries send 1019 +5 s, get 1019 +10 s; no fallback;
 * statement 2026-09-29; sections accountInformation, openPositions; 21.4 s`. Only dates, IBKR codes, section ids and
 * durations: never the token, the query ID or an amount.
 */
export function formatFlexPullLog(p: FlexPullLog): string {
  const parts = [
    p.range ? `asked ${p.range.from}..${p.range.to}` : "asked the query's own period",
    p.retries.length ? `retries ${p.retries.map((r) => `${r.stage} ${r.code} +${Math.round(r.waitMs / 1000)} s`).join(", ")}` : "no retries",
    p.fallback ? `fallback to ${p.fallback.to} after ${p.fallback.code}` : "no fallback",
    p.error
      ? `failed ${p.error.code}${p.error.flexCode ? ` (IBKR ${p.error.flexCode})` : ""}`
      : `statement ${p.statementDate ?? "?"}; sections ${p.sections ? p.sections.join(", ") || "none" : "not reported"}`,
    seconds(p.ms),
  ];
  return `[yomi] IBKR Flex pull (${p.kind}): ${parts.join("; ")}`;
}
