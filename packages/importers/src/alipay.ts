import { type Notice, ParseError } from "./errors";
import type { NormalizedRow, ParseResult } from "./types";
import { parseAmountMinor } from "./util/amount";
import { clean, isBlankRow, parseCsv } from "./util/csv";
import { neutralSign } from "./util/neutral";
import { countMismatch, neutralDirectionUnknown, unknownBucket } from "./util/warnings";
import { parsePreamble } from "./util/preamble";
import { localTextToIso } from "./util/time";

const REQUIRED = ["交易时间", "交易分类", "交易对方", "商品说明", "收/支", "金额", "交易状态", "交易订单号"] as const;
const DATA_ROW = /^\d{4}-\d{1,2}-\d{1,2}/;

/**
 * Alipay transaction-detail (交易明细) CSV (GBK). Layout: a free-text preamble with the declared summary, the header row
 * starting with 交易时间 (plus a trailing empty column), data rows, end at the first blank line.
 *
 * Rules:
 * - 支出 → out / negative / expense; 收入 → in / positive / income.
 * - 不计收支 → neutral / transfer; sign from keywords (see neutralSign), unmatched → negative + warning.
 * - Refunds (交易分类=退款 or 交易状态=退款成功) → kind refund, positive, whatever bucket they sit in
 *   (in the real export they are 不计收支 and their id is `<original id>_<refund id>`).
 * - 交易状态=交易关闭 → status closed (a fully refunded purchase shows up closed, alongside its refund row).
 *   That refund row (id `<closed id>_<refund id>`) becomes kind transfer: the purchase is already out of
 *   spending, so counting the refund too would subtract it twice.
 * - 不计收支 rows about 收益 (e.g. 余额宝收益) → kind income; direction stays neutral for reconciliation.
 */
export function parseAlipay(bytes: Uint8Array): ParseResult {
  const text = new TextDecoder("gbk").decode(bytes);
  const lines = parseCsv(text);
  const headerAt = lines.findIndex((cells) => clean(cells[0]) === "交易时间");
  if (headerAt < 0) throw new ParseError("import_header_not_found", "Alipay statement: header row not found (交易时间)", { header: "交易时间" });

  const { declared, periodStart, periodEnd } = parsePreamble(lines.slice(0, headerAt).map((c) => c.join(",")));
  const header = lines[headerAt]!.map((h) => clean(h));
  const index = new Map<string, number>();
  header.forEach((h, i) => {
    if (h !== "" && !index.has(h)) index.set(h, i);
  });
  const missing = REQUIRED.filter((h) => !index.has(h));
  if (missing.length) throw new ParseError("import_missing_columns", `Alipay statement: missing columns ${missing.join(", ")}`, { columns: missing.join(", ") });

  const warnings: Notice[] = [];
  const rows: NormalizedRow[] = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    const cells = lines[i]!;
    if (isBlankRow(cells) || !DATA_ROW.test(clean(cells[0]))) break;
    const lineNo = rows.length + 1;
    const get = (name: string) => clean(cells[index.get(name) ?? -1]);

    const raw: Record<string, string> = {};
    for (const [name, at] of index) raw[name] = cells[at] ?? "";

    const bucket = get("收/支");
    const category = get("交易分类");
    const state = get("交易状态");
    const counterparty = get("交易对方");
    const description = get("商品说明");
    const magnitude = Math.abs(parseAmountMinor(get("金额")));
    const isRefund = category === "退款" || state === "退款成功";

    let direction: NormalizedRow["direction"];
    let kind: NormalizedRow["kind"];
    let sign: 1 | -1;
    if (bucket === "支出") {
      direction = "out";
      kind = "expense";
      sign = -1;
    } else if (bucket === "收入") {
      direction = "in";
      kind = "income";
      sign = 1;
    } else {
      if (bucket !== "不计收支") warnings.push(unknownBucket(lineNo, bucket));
      direction = "neutral";
      kind = "transfer";
      const s = isRefund ? 1 : neutralSign(`${category} ${description} ${counterparty}`);
      if (s === null) warnings.push(neutralDirectionUnknown(lineNo));
      sign = s ?? -1;
      if (/收益/.test(`${category} ${description}`)) kind = "income";
    }
    if (isRefund) {
      kind = "refund";
      sign = 1;
    }

    const paymentMethod = get("收/付款方式");
    rows.push({
      source: "alipay",
      lineNo,
      externalId: get("交易订单号") || null,
      occurredAt: localTextToIso(get("交易时间")),
      amountMinor: sign * magnitude,
      currency: "CNY",
      originalAmountMinor: null,
      originalCurrency: null,
      direction,
      kind,
      status: state === "交易关闭" ? "closed" : "ok",
      counterparty,
      description,
      sourceCategory: category || null,
      paymentMethod: paymentMethod === "" || paymentMethod === "/" ? null : paymentMethod,
      raw,
    });
  }

  const closedIds = new Set(rows.filter((r) => r.status === "closed" && r.externalId).map((r) => r.externalId));
  for (const r of rows) {
    const originalId = r.kind === "refund" && r.externalId?.includes("_") ? r.externalId.split("_")[0] : null;
    if (originalId && closedIds.has(originalId)) r.kind = "transfer";
  }

  if (declared.count !== undefined && declared.count !== rows.length) {
    warnings.push(countMismatch(declared.count, rows.length));
  }
  return { source: "alipay", rows, declared, periodStart, periodEnd, warnings };
}
