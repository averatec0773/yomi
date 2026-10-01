const IN_KEYWORDS = ["收益", "利息", "转入", "退款", "卖出", "赎回"];
const OUT_KEYWORDS = ["提现", "转出", "买入", "申购", "还款", "缴费"];

/**
 * Sign for a neutral (不计收支 / `/`) row, which the file leaves unsigned.
 * In-keywords win over out-keywords (e.g. 收益 is money arriving). Returns null when
 * nothing matches; callers then treat the row as outgoing and emit a warning.
 */
export function neutralSign(text: string): 1 | -1 | null {
  if (IN_KEYWORDS.some((k) => text.includes(k))) return 1;
  if (OUT_KEYWORDS.some((k) => text.includes(k))) return -1;
  return null;
}
