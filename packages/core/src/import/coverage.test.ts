import { describe, expect, it } from "vitest";
import { statementCoverage } from "./coverage";

describe("statementCoverage", () => {
  it("keeps whole days and a 23:59 end", () => {
    expect(statementCoverage("2026-07-01", "2026-09-29")).toEqual({ start: "2026-07-01", end: "2026-09-29" });
    expect(statementCoverage("2026-07-01T00:00:00+08:00", "2026-09-29T23:59:59+08:00")).toEqual({ start: "2026-07-01", end: "2026-09-29" });
    expect(statementCoverage("2026-09-01T00:00:00-05:00", "2026-09-29T23:59:59-05:00")).toEqual({ start: "2026-09-01", end: "2026-09-29" });
  });

  it("an export taken during the end day covers through the day before", () => {
    expect(statementCoverage("2026-07-01T00:00:00+08:00", "2026-09-25T10:12:41+08:00")).toEqual({ start: "2026-07-01", end: "2026-09-24" });
    expect(statementCoverage("2026-07-01T00:00:00+08:00", "2026-09-25T23:58:00+08:00").end).toBe("2026-09-24");
  });

  it("drops what it cannot read", () => {
    expect(statementCoverage(undefined, undefined)).toEqual({ start: null, end: null });
    expect(statementCoverage("2026-02-30", "garbage")).toEqual({ start: null, end: null });
    expect(statementCoverage("2026-09-25T00:00:00+08:00", "2026-09-25T09:00:00+08:00")).toEqual({ start: "2026-09-25", end: null });
  });
});
