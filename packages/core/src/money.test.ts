import { describe, expect, it } from "vitest";
import { formatMinor, parseAmountToMinor, splitEqual } from "./money";

describe("parseAmountToMinor", () => {
  it.each([
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    ["0.07", 7],
    [".5", 50],
    ["-12.34", -1234],
    ["+1", 100],
    ["1,234.56", 123456],
    ["¥1,234.56", 123456],
    ["￥88.00", 8800],
    ["$12.5", 1250],
    ["-$3.10", -310],
    ["USD 3.10", 310],
    ["  7.10  ", 710],
    ["12.340", 1234],
    ["0", 0],
    ["12.", 1200],
    ["-0.00", 0],
  ])("%s → %d", (input, expected) => {
    expect(parseAmountToMinor(input)).toBe(expected);
  });

  it("does not suffer float rounding", () => {
    // 0.1 + 0.2 style traps and values that are inexact in binary.
    expect(parseAmountToMinor("0.29")).toBe(29);
    expect(parseAmountToMinor("1.15")).toBe(115);
    expect(parseAmountToMinor("4.35")).toBe(435);
    expect(parseAmountToMinor("5161.25")).toBe(516125);
  });

  it("supports zero-decimal currencies", () => {
    expect(parseAmountToMinor("1,200", 0)).toBe(1200);
  });

  it.each(["", "abc", "1.2.3", "12.345", "1e3", "--1", "-", "NaN"])("rejects %j", (input) => {
    expect(() => parseAmountToMinor(input)).toThrow();
  });
});

describe("formatMinor", () => {
  it.each([
    [123456, "CNY", "¥1,234.56"],
    [-123456, "CNY", "-¥1,234.56"],
    [7, "USD", "$0.07"],
    [0, "USD", "$0.00"],
    [100000000, "HKD", "HK$1,000,000.00"],
    [1200, "JPY", "JP¥1,200"],
    [510, "CHF", "CHF 5.10"],
  ])("%d %s → %s", (minor, currency, expected) => {
    expect(formatMinor(minor, currency)).toBe(expected);
  });

  it("round-trips with parseAmountToMinor", () => {
    for (const n of [0, 1, 99, 100, 123456789, -42]) {
      expect(parseAmountToMinor(formatMinor(n, "CNY"))).toBe(n);
    }
  });

  it("rejects non-integers", () => {
    expect(() => formatMinor(1.5, "CNY")).toThrow();
  });
});

describe("splitEqual", () => {
  it("gives the remainder to index 0", () => {
    expect(splitEqual(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEqual(101, 4)).toEqual([26, 25, 25, 25]);
  });

  it("splits evenly when possible", () => {
    expect(splitEqual(900, 3)).toEqual([300, 300, 300]);
    expect(splitEqual(5, 1)).toEqual([5]);
  });

  it("keeps the sign and the sum for negative totals", () => {
    const shares = splitEqual(-1000, 3);
    expect(shares).toEqual([-334, -333, -333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(-1000);
  });

  it("handles zero and tiny totals", () => {
    expect(splitEqual(0, 3)).toEqual([0, 0, 0]);
    expect(splitEqual(2, 3)).toEqual([2, 0, 0]);
  });

  it("always sums to the total", () => {
    for (let total = 0; total < 500; total += 7) {
      for (let n = 1; n <= 6; n++) {
        expect(splitEqual(total, n).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it("rejects bad input", () => {
    expect(() => splitEqual(100, 0)).toThrow();
    expect(() => splitEqual(10.5, 2)).toThrow();
  });
});
