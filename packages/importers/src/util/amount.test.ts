import { describe, expect, it } from "vitest";
import { CodedError } from "../errors";
import { numberToMinor, parseAmountMinor } from "./amount";

/** The error code `fn` throws, or null when it returns. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    return e instanceof CodedError ? e.code : `not coded: ${String(e)}`;
  }
  return null;
}

describe("parseAmountMinor", () => {
  it.each([
    ["¥1,234.56", 123456],
    ["￥12", 1200],
    ["12.00元", 1200],
    ["-3.5", -350],
    ["+7", 700],
    ["-0.5", -50],
    ["0.05", 5],
    ["12.", 1200],
    [" 1 234.5 ", 123450],
    ["1,000,000.01", 100000001],
    ["90071992547409.91", Number.MAX_SAFE_INTEGER],
  ])("%j is %i minor units", (text, minor) => {
    expect(parseAmountMinor(text)).toBe(minor);
  });

  it.each(["", "abc", "1.234", "1e3", "--1", "1.2.3", "$5", "12,34.5.6"])("refuses %j", (text) => {
    expect(codeOf(() => parseAmountMinor(text))).toBe("import_bad_amount");
  });

  it("refuses amounts past the safe integer range instead of losing cents", () => {
    expect(codeOf(() => parseAmountMinor("90071992547409.92"))).toBe("import_amount_out_of_range");
    expect(codeOf(() => parseAmountMinor("-99999999999999999"))).toBe("import_amount_out_of_range");
  });
});

describe("numberToMinor", () => {
  it.each([
    [12, 1200],
    [12.34, 1234],
    [-0.5, -50],
    [0.1 + 0.2, 30],
    [19.99, 1999],
    [21474836.47, 2147483647],
    [90_000_000_000_000, 9_000_000_000_000_000],
  ])("%d is %i minor units", (value, minor) => {
    expect(numberToMinor(value)).toBe(minor);
  });

  it.each([1.234, 1.005, 0.001, -2.5001])("refuses %d, which has more than two decimals", (value) => {
    expect(codeOf(() => numberToMinor(value))).toBe("import_amount_too_precise");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("refuses %d", (value) => {
    expect(codeOf(() => numberToMinor(value))).toBe("import_bad_amount");
  });
});
