import { describe, expect, it } from "vitest";
import { axisScale, MIN_SPAN_RATIO, tickLabel, yFraction } from "./chart-scale";

describe("axisScale", () => {
  it("keeps a 0.7% move small: the span is at least 5% of the value, centred and padded", () => {
    // $1,001.00 → $994.00 → $996.00
    const s = axisScale([100100, 99400, 99600], "USD")!;
    const span = s.hi - s.lo;
    expect(span).toBeGreaterThanOrEqual(100100 * MIN_SPAN_RATIO);
    // The move fills well under a fifth of the height.
    expect(yFraction(99400, s) - yFraction(100100, s)).toBeLessThan(0.2);
    expect(s.lo).toBeLessThan(99400);
    expect(s.hi).toBeGreaterThan(100100);
    // Round ticks inside the domain, whole dollars.
    expect(s.ticks.length).toBeGreaterThanOrEqual(2);
    for (const v of s.ticks) {
      expect(v).toBeGreaterThanOrEqual(s.lo);
      expect(v).toBeLessThanOrEqual(s.hi);
      expect(v % s.step).toBe(0);
    }
    expect(s.step % 100).toBe(0);
  });

  it("uses the data range when it is wider than the minimum span", () => {
    const s = axisScale([1_000_000, 2_000_000], "USD")!;
    expect(s.hi - s.lo).toBeCloseTo(1_000_000 * 1.16, -2);
    expect(s.ticks).toEqual([1_000_000, 1_500_000, 2_000_000]);
  });

  it("does not push one-sided data across zero, and has a floor of 10 units", () => {
    const pos = axisScale([0, 300], "USD")!;
    expect(pos.lo).toBe(0);
    expect(pos.hi).toBeGreaterThanOrEqual(1000);
    const neg = axisScale([-18324, -17000], "USD")!;
    expect(neg.hi).toBeLessThanOrEqual(0);
    const flat = axisScale([0, 0], "JPY")!;
    expect([flat.lo, flat.hi >= 10, flat.step >= 1]).toEqual([0, true, true]);
    expect(axisScale([], "USD")).toBeNull();
  });

  it("always labels two to seven ticks", () => {
    for (let lo = 1_000; lo < 50_000_000; lo = Math.round(lo * 1.37) + 13) {
      for (const r of [0, 0.007, 0.05, 0.3, 1, 2]) {
        const s = axisScale([lo, Math.round(lo * (1 + r))], "USD")!;
        expect(s.ticks.length, `${lo} +${r}`).toBeGreaterThanOrEqual(2);
        expect(s.ticks.length, `${lo} +${r}`).toBeLessThanOrEqual(7);
      }
    }
  });

  it("spans zero when the data does", () => {
    const s = axisScale([-5000, 12000], "USD")!;
    expect(s.lo).toBeLessThan(-5000);
    expect(s.ticks).toContain(0);
  });
});

describe("tickLabel", () => {
  it("drops cents on whole steps, keeps them below one unit, shortens large values", () => {
    expect(tickLabel(100000, "USD", 500)).toBe("$1,000");
    expect(tickLabel(99950, "USD", 50)).toBe("$999.50");
    expect(tickLabel(-250000, "USD", 50000)).toBe("−$2,500");
    expect(tickLabel(12_000_000, "USD", 500_000)).toBe("$120K");
    expect(tickLabel(122_500_00, "CNY", 250_000)).toBe("¥122.5K");
    expect(tickLabel(125_000_000, "USD", 2_500_000)).toBe("$1.25M");
    expect(tickLabel(1000, "JPY", 100)).toBe("JP¥1,000");
  });
});
