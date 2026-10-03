import { describe, expect, it } from "vitest";
import { LedgerError } from "../ledger/errors";
import {
  analysisPresetRange,
  defaultPeriod,
  matchAnalysisPreset,
  periodKindOf,
  periodOf,
  resolveAnalysisPeriod,
  typicalRanges,
  weekOf,
} from "./period";
import { shiftRange } from "../stats/period";
import { weekdayOf } from "../time/day";

describe("weekOf", () => {
  it("starts on Monday by default, across month and year ends", () => {
    expect(weekOf("2026-09-30")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(weekOf("2026-09-28")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(weekOf("2026-10-04")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(weekOf("2027-01-01")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
    expect(weekOf("2024-02-29")).toEqual({ from: "2024-02-26", to: "2024-03-03" });
  });

  it("takes another week start (Sunday)", () => {
    expect(weekOf("2026-09-30", 0)).toEqual({ from: "2026-09-27", to: "2026-10-03" });
    expect(weekOf("2026-09-27", 0)).toEqual({ from: "2026-09-27", to: "2026-10-03" });
    expect(weekOf("2027-01-01", 0)).toEqual({ from: "2026-12-27", to: "2027-01-02" });
  });

  it("knows the weekday", () => {
    expect(weekdayOf("2026-09-30")).toBe(3);
    expect(weekdayOf("2026-10-04")).toBe(0);
  });

  it("rejects a bad date", () => {
    expect(() => weekOf("2026-02-30")).toThrow(LedgerError);
  });
});

describe("periodOf / periodKindOf", () => {
  it("names the day, week or month containing a date", () => {
    expect(periodOf("day", "2026-09-29")).toEqual({ from: "2026-09-29", to: "2026-09-29" });
    expect(periodOf("week", "2026-09-29")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(periodOf("month", "2026-02-14")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodOf("year", "2026-02-14")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("infers the kind from the range", () => {
    expect(periodKindOf({ from: "2026-09-29", to: "2026-09-29" })).toBe("day");
    expect(periodKindOf({ from: "2026-09-28", to: "2026-10-04" })).toBe("week");
    expect(periodKindOf({ from: "2026-09-27", to: "2026-10-03" })).toBe("range");
    expect(periodKindOf({ from: "2026-09-27", to: "2026-10-03" }, 0)).toBe("week");
    expect(periodKindOf({ from: "2026-09-01", to: "2026-09-30" })).toBe("month");
    expect(periodKindOf({ from: "2026-07-01", to: "2026-09-30" })).toBe("range");
    expect(periodKindOf({ from: "2026-01-01", to: "2026-12-31" })).toBe("year");
    expect(periodKindOf({ from: "2026-02-01", to: "2027-01-31" })).toBe("range");
  });
});

describe("defaultPeriod and stepping", () => {
  it("opens Day on yesterday and Week and Month on the current one", () => {
    expect(defaultPeriod("day", "2026-09-30")).toEqual({ from: "2026-09-29", to: "2026-09-29" });
    expect(defaultPeriod("day", "2026-10-01")).toEqual({ from: "2026-09-30", to: "2026-09-30" });
    expect(defaultPeriod("week", "2026-09-30")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(defaultPeriod("month", "2026-09-30")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("steps by a day, seven days or a calendar month", () => {
    expect(shiftRange({ from: "2026-09-29", to: "2026-09-29" }, 1)).toEqual({ from: "2026-09-30", to: "2026-09-30" });
    expect(shiftRange({ from: "2026-09-28", to: "2026-10-04" }, -1)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(shiftRange({ from: "2026-03-01", to: "2026-03-31" }, -1)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("resolves presets and period + date", () => {
    const today = "2026-09-30";
    expect(analysisPresetRange("today", today)).toEqual({ from: today, to: today });
    expect(analysisPresetRange("yesterday", today)).toEqual({ from: "2026-09-29", to: "2026-09-29" });
    expect(analysisPresetRange("this_week", today)).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(analysisPresetRange("last_week", today)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(analysisPresetRange("last_month", today)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(analysisPresetRange("this_year", today)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(matchAnalysisPreset({ from: "2026-09-28", to: "2026-10-04" }, today)).toBe("this_week");
    expect(matchAnalysisPreset({ from: "2026-09-29", to: "2026-09-29" }, today)).toBe("yesterday");
    expect(matchAnalysisPreset({ from: "2026-09-27", to: "2026-09-27" }, today)).toBe("custom");
    expect(resolveAnalysisPeriod({ period: "day" }, today)).toEqual({ from: "2026-09-29", to: "2026-09-29" });
    expect(resolveAnalysisPeriod({ period: "week", date: "2026-09-01" }, today)).toEqual({ from: "2026-08-31", to: "2026-09-06" });
    expect(resolveAnalysisPeriod({ from: "2026-09-05", to: "2026-09-20" }, today)).toEqual({ from: "2026-09-05", to: "2026-09-20" });
    expect(() => resolveAnalysisPeriod({ from: "2026-09-20", to: "2026-09-05" }, today)).toThrow(LedgerError);
  });
});

describe("typicalRanges", () => {
  it("lists 28 days, 4 weeks or 3 months before the period, oldest first", () => {
    const days = typicalRanges({ from: "2026-09-29", to: "2026-09-29" }, "day");
    expect(days).toHaveLength(28);
    expect(days[0]).toEqual({ from: "2026-09-01", to: "2026-09-01" });
    expect(days.at(-1)).toEqual({ from: "2026-09-28", to: "2026-09-28" });
    expect(typicalRanges({ from: "2026-09-28", to: "2026-10-04" }, "week")).toEqual([
      { from: "2026-08-31", to: "2026-09-06" },
      { from: "2026-09-07", to: "2026-09-13" },
      { from: "2026-09-14", to: "2026-09-20" },
      { from: "2026-09-21", to: "2026-09-27" },
    ]);
    expect(typicalRanges({ from: "2026-03-01", to: "2026-03-31" }, "month")).toEqual([
      { from: "2025-12-01", to: "2025-12-31" },
      { from: "2026-01-01", to: "2026-01-31" },
      { from: "2026-02-01", to: "2026-02-28" },
    ]);
    expect(typicalRanges({ from: "2026-01-01", to: "2026-12-31" }, "year").map((r) => r.from)).toEqual(["2023-01-01", "2024-01-01", "2025-01-01"]);
    expect(typicalRanges({ from: "2026-07-01", to: "2026-09-30" }, "range")).toEqual([]);
  });
});
