import { describe, expect, it } from "vitest";
import { LedgerError } from "../ledger/errors";
import {
  addDays,
  assertRange,
  daysInclusive,
  isDate,
  matchPreset,
  monthsIn,
  presetRange,
  previousRange,
  resolvePeriod,
  shiftRange,
  wholeMonths,
} from "./period";

describe("shiftRange", () => {
  it("steps whole months by their own count", () => {
    expect(shiftRange({ from: "2026-09-01", to: "2026-09-30" }, -1)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(shiftRange({ from: "2026-01-01", to: "2026-01-31" }, -1)).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(shiftRange({ from: "2026-07-01", to: "2026-09-30" }, 1)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(shiftRange({ from: "2026-01-01", to: "2026-12-31" }, -1)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(shiftRange({ from: "2024-02-01", to: "2024-02-29" }, 1)).toEqual({ from: "2024-03-01", to: "2024-03-31" });
  });

  it("steps other ranges by their length in days", () => {
    expect(shiftRange({ from: "2026-09-05", to: "2026-09-20" }, 1)).toEqual({ from: "2026-09-21", to: "2026-10-06" });
    expect(shiftRange({ from: "2026-09-05", to: "2026-09-05" }, -1)).toEqual({ from: "2026-09-04", to: "2026-09-04" });
  });
});

describe("date math", () => {
  it("validates calendar dates, leap years included", () => {
    expect(isDate("2024-02-29")).toBe(true);
    expect(isDate("2026-02-29")).toBe(false);
    expect(isDate("2000-02-29")).toBe(true);
    expect(isDate("1900-02-29")).toBe(false);
    expect(isDate("2026-04-31")).toBe(false);
    expect(isDate("2026-9-01")).toBe(false);
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysInclusive("2024-01-01", "2024-12-31")).toBe(366);
    expect(daysInclusive("2026-09-29", "2026-09-29")).toBe(1);
  });

  it("rejects bad ranges and spans over five years", () => {
    expect(() => assertRange({ from: "2026-09-30", to: "2026-09-01" })).toThrow(LedgerError);
    expect(() => assertRange({ from: "2026-02-30", to: "2026-03-01" })).toThrow(LedgerError);
    expect(() => assertRange({ from: "2021-01-01", to: "2025-12-31" })).not.toThrow();
    expect(() => assertRange({ from: "2021-01-01", to: "2026-01-01" })).toThrow(expect.objectContaining({ code: "range_too_long" }));
    expect(() => assertRange({ from: "2020-01-01", to: "2024-12-31" })).not.toThrow();
    expect(() => assertRange({ from: "2024-02-29", to: "2029-02-28" })).not.toThrow();
    expect(() => assertRange({ from: "2024-02-29", to: "2029-03-01" })).toThrow(expect.objectContaining({ code: "range_too_long" }));
  });

  it("detects whole-month ranges", () => {
    expect(wholeMonths({ from: "2026-09-01", to: "2026-09-30" })).toBe(1);
    expect(wholeMonths({ from: "2024-02-01", to: "2024-02-29" })).toBe(1);
    expect(wholeMonths({ from: "2024-02-01", to: "2024-02-28" })).toBeNull();
    expect(wholeMonths({ from: "2025-11-01", to: "2026-01-31" })).toBe(3);
    expect(wholeMonths({ from: "2026-09-02", to: "2026-09-30" })).toBeNull();
  });

  it("previous period: calendar months step back by months, other ranges by equal days", () => {
    expect(previousRange({ from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(previousRange({ from: "2024-03-01", to: "2024-03-31" })).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(previousRange({ from: "2026-07-01", to: "2026-09-30" })).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(previousRange({ from: "2026-01-01", to: "2026-12-31" })).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    const r = { from: "2026-09-10", to: "2026-09-19" };
    const p = previousRange(r);
    expect(p).toEqual({ from: "2026-08-31", to: "2026-09-09" });
    expect(daysInclusive(p.from, p.to)).toBe(daysInclusive(r.from, r.to));
    // Across a leap day.
    expect(previousRange({ from: "2024-03-01", to: "2024-03-10" })).toEqual({ from: "2024-02-20", to: "2024-02-29" });
  });

  it("lists touched months", () => {
    expect(monthsIn({ from: "2025-11-15", to: "2026-02-03" })).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthsIn({ from: "2026-09-01", to: "2026-09-30" })).toEqual(["2026-09"]);
  });
});

describe("presets", () => {
  const today = "2026-03-15";
  it("resolves against today", () => {
    expect(presetRange("this_month", today)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(presetRange("last_month", today)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("last_3_months", today)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(presetRange("last_6_months", today)).toEqual({ from: "2025-10-01", to: "2026-03-31" });
    expect(presetRange("this_year", today)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(presetRange("last_year", today)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(presetRange("last_month", "2024-03-01")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(presetRange("last_month", "2026-01-10")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("custom ranges are validated; ranges map back to a preset", () => {
    expect(resolvePeriod({ preset: "custom", from: "2026-01-05", to: "2026-02-10" }, today)).toEqual({ from: "2026-01-05", to: "2026-02-10" });
    expect(() => resolvePeriod({ preset: "custom", from: "2026-02-10", to: "2026-01-05" }, today)).toThrow(LedgerError);
    expect(resolvePeriod({ preset: "this_year" }, today)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(matchPreset({ from: "2026-01-01", to: "2026-03-31" }, today)).toBe("last_3_months");
    expect(matchPreset({ from: "2026-01-02", to: "2026-03-31" }, today)).toBe("custom");
  });
});
