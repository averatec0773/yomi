import { describe, expect, it } from "vitest";
import { addDays, dayDiff, daysInclusive, isDate, monthRange, shiftMonth, weekdayOf } from "./day";

describe("calendar arithmetic", () => {
  it("steps over month, year and leap-day boundaries", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(dayDiff("2026-09-29", "2026-10-02")).toBe(3);
    expect(dayDiff("2026-10-02", "2026-09-29")).toBe(-3);
    expect(daysInclusive("2026-09-01", "2026-09-30")).toBe(30);
  });

  it("reads a timestamp by its stated date", () => {
    expect(addDays("2026-09-30T23:30:00+08:00", 1)).toBe("2026-10-01");
    expect(dayDiff("2026-09-30", "2026-10-01T01:00:00-05:00")).toBe(1);
  });

  it("knows weekdays, real dates and months", () => {
    expect(weekdayOf("2026-10-04")).toBe(0);
    expect(weekdayOf("2026-10-02")).toBe(5);
    expect([isDate("2026-02-29"), isDate("2024-02-29"), isDate("2026-13-01")]).toEqual([false, true, false]);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthRange("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
  });
});
