import type { Notice } from "./errors";

/** `sms` rows come from a pasted bank alert through quick add, never from a statement file. */
export type SourceId = "alipay" | "wechat" | "icbc_pdf" | "plaid" | "boa_csv" | "sms";

export interface NormalizedRow {
  source: SourceId;
  /** 1-based position of the row among the file's transaction rows. */
  lineNo: number;
  /** Alipay 交易订单号 / WeChat 交易单号 / Plaid transaction_id / BoA card Reference Number; null when the source has no id (ICBC, BoA checking). */
  externalId: string | null;
  /** ISO local time with offset, e.g. 2026-09-01T12:30:00+08:00. */
  occurredAt: string;
  /** Signed integer minor units; negative = money leaving me. */
  amountMinor: number;
  currency: string;
  /** Set when the transaction currency differs from the booked currency (ICBC 交易币种 vs 入账币种). */
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  direction: "out" | "in" | "neutral";
  kind: "expense" | "income" | "transfer" | "refund";
  status: "ok" | "closed";
  counterparty: string;
  description: string;
  sourceCategory: string | null;
  paymentMethod: string | null;
  /** Header name to original cell text, verbatim. */
  raw: Record<string, string>;
}

export interface DeclaredBucket {
  count: number;
  minor: number;
}

/** Totals the file itself states (header lines or per-page sums), used to reconcile the parse. */
export interface DeclaredTotals {
  count?: number;
  income?: DeclaredBucket;
  expense?: DeclaredBucket;
  neutral?: DeclaredBucket;
}

export interface ParseResult {
  source: SourceId;
  rows: NormalizedRow[];
  declared: DeclaredTotals;
  periodStart?: string;
  periodEnd?: string;
  warnings: Notice[];
}
