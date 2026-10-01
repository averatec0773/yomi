import { ParseError } from "../errors";

/**
 * Decimal money text to integer minor units using string arithmetic only.
 * Accepts `¥1,234.56`, `￥12`, `-3.5`, `12.00元`. Throws on anything else.
 */
export function parseAmountMinor(text: string): number {
  const s = text.replace(/[¥￥,\s元]/g, "");
  const m = /^([+-]?)(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new ParseError("import_bad_amount", `Cannot parse amount: ${JSON.stringify(text)}`, { value: text });
  const [, sign, int = "0", frac = ""] = m;
  const minor = Number(int) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new ParseError("import_amount_out_of_range", `Amount out of range: ${JSON.stringify(text)}`, { value: text });
  return sign === "-" ? -minor : minor;
}

/**
 * Spreadsheet number cell (yuan) to minor units.
 * Safe for values that were written with at most 2 decimals: such a value is stored as
 * the nearest double, so `value * 100` lands within a few ulps of the exact integer
 * (error far below 0.5 for any amount under 2^53 / 100), and one Math.round recovers it.
 * Values carrying more than 2 decimals are rejected rather than silently rounded.
 */
export function numberToMinor(value: number): number {
  if (!Number.isFinite(value)) throw new ParseError("import_bad_amount", `Invalid amount: ${value}`, { value: String(value) });
  const minor = Math.round(value * 100);
  if (Math.abs(minor - value * 100) > 1e-6 * Math.max(1, Math.abs(minor))) {
    throw new ParseError("import_amount_too_precise", `Amount has more than two decimals: ${value}`, { value: String(value) });
  }
  return minor;
}
