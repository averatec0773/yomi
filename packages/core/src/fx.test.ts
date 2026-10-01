import { describe, expect, it } from "vitest";
import { convertByRate, convertFromRate, normalizeRate, rateFromAmounts } from "./money";

describe("FX rates", () => {
  it("normalizes decimal strings and rejects the rest", () => {
    expect(normalizeRate("7.20")).toBe("7.2");
    expect(normalizeRate(" 007.2500 ")).toBe("7.25");
    expect(normalizeRate(".5")).toBe("0.5");
    expect(normalizeRate("150")).toBe("150");
    for (const bad of ["", "0", "0.000", "-7", "7.2.1", "abc", "1e3"]) expect(normalizeRate(bad)).toBeNull();
  });

  it("converts with one rounding, half away from zero", () => {
    expect(convertByRate(5000, "USD", "7.2", "CNY")).toBe(36000);
    expect(convertByRate(-5000, "USD", "7.2", "CNY")).toBe(-36000);
    expect(convertByRate(1, "USD", "7.25", "CNY")).toBe(7); // 0.0725 CNY = 7.25 fen → 7
    expect(convertByRate(2, "USD", "7.25", "CNY")).toBe(15); // 14.5 fen → 15
    expect(convertByRate(12345, "USD", "149.87", "JPY")).toBe(18501); // $123.45 × 149.87 = ¥18,501.45
    expect(convertFromRate(36000, "CNY", "7.2", "USD")).toBe(5000);
    expect(convertFromRate(18501, "JPY", "149.87", "USD")).toBe(12345);
  });

  it("derives the rate from two amounts", () => {
    expect(rateFromAmounts(5000, "USD", 36000, "CNY")).toBe("7.2");
    expect(rateFromAmounts(-5000, "USD", -36000, "CNY")).toBe("7.2");
    expect(rateFromAmounts(10000, "USD", 72345, "CNY")).toBe("7.2345");
    expect(rateFromAmounts(3000, "USD", 100000, "CNY")).toBe("33.33333333");
    expect(rateFromAmounts(12345, "USD", 18501, "JPY")).toBe("149.86634265");
    expect(rateFromAmounts(0, "USD", 1, "CNY")).toBeNull();
  });

  it("amount → rate → amount gives the amount back", () => {
    const pairs: [string, string][] = [
      ["USD", "CNY"],
      ["CNY", "USD"],
      ["USD", "JPY"],
      ["JPY", "USD"],
      ["EUR", "GBP"],
    ];
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return 1 + (seed % n);
    };
    for (const [base, other] of pairs) {
      for (let i = 0; i < 300; i++) {
        const baseMinor = rnd(10_000_000);
        const otherMinor = rnd(50_000_000);
        const rate = rateFromAmounts(baseMinor, base, otherMinor, other)!;
        expect(convertByRate(baseMinor, base, rate, other), `${baseMinor} ${base} → ${otherMinor} ${other} @ ${rate}`).toBe(otherMinor);
      }
    }
  });

  it("rate → amount → rate reproduces the rate when the amount is large enough to carry it", () => {
    for (const rate of ["7.2", "7.1234", "0.1389", "149.87", "1"]) {
      const other = convertByRate(1_000_000, "USD", rate, "CNY");
      expect(rateFromAmounts(1_000_000, "USD", other, "CNY")).toBe(rate);
    }
  });
});
