import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { zhCN } from "../i18n/zh-CN";
import { dayLabel, monthLabel } from "./month";
import { isDateString, previousLabel, rangeLabel, shortMonth, wholeMonthCount } from "./period";

describe("period labels", () => {
  it("names ranges plainly in Chinese", () => {
    expect(rangeLabel("2026-09-01", "2026-09-30", "zh-CN")).toBe("2026年9月");
    expect(rangeLabel("2026-01-01", "2026-12-31", "zh-CN")).toBe("2026年");
    expect(rangeLabel("2026-07-01", "2026-09-30", "zh-CN")).toBe("2026年7月 至 9月");
    expect(rangeLabel("2025-11-01", "2026-01-31", "zh-CN")).toBe("2025年11月 至 2026年1月");
    expect(rangeLabel("2026-09-05", "2026-09-20", "zh-CN")).toBe("2026年9月5日 至 9月20日");
    expect(rangeLabel("2025-11-15", "2026-02-03", "zh-CN")).toBe("2025年11月15日 至 2026年2月3日");
    expect(rangeLabel("2026-09-05", "2026-09-05", "zh-CN")).toBe("2026年9月5日");
  });

  it("names ranges plainly in English", () => {
    expect(rangeLabel("2026-09-01", "2026-09-30", "en")).toBe("September 2026");
    expect(rangeLabel("2026-01-01", "2026-12-31", "en")).toBe("2026");
    expect(rangeLabel("2026-07-01", "2026-09-30", "en")).toBe("Jul – Sep 2026");
    expect(rangeLabel("2025-11-01", "2026-01-31", "en")).toBe("Nov 2025 – Jan 2026");
    expect(rangeLabel("2026-09-05", "2026-09-20", "en")).toBe("Sep 5 – 20, 2026");
    expect(rangeLabel("2026-09-05", "2026-09-05", "en")).toBe("Sep 5, 2026");
  });

  it("names the previous period", () => {
    expect(previousLabel("2026-09-01", "2026-09-30", 30, zhCN)).toBe("上月");
    expect(previousLabel("2026-01-01", "2026-12-31", 365, zhCN)).toBe("上一年");
    expect(previousLabel("2026-07-01", "2026-09-30", 92, zhCN)).toBe("前 3 个月");
    expect(previousLabel("2026-09-05", "2026-09-14", 10, zhCN)).toBe("前 10 天");
    expect(previousLabel("2026-09-01", "2026-09-30", 30, en)).toBe("last month");
    expect(previousLabel("2026-07-01", "2026-09-30", 92, en)).toBe("the previous 3 months");
    expect(previousLabel("2026-09-05", "2026-09-05", 1, en)).toBe("the previous day");
  });

  it("formats months and days per locale", () => {
    expect(monthLabel("2026-09", "zh-CN")).toBe("2026年9月");
    expect(monthLabel("2026-09", "en")).toBe("September 2026");
    expect(shortMonth("2026-09", "zh-CN")).toBe("9月");
    expect(shortMonth("2026-01", "zh-CN", true)).toBe("2026年1月");
    expect(shortMonth("2026-01", "en", true)).toBe("Jan 2026");
    expect(dayLabel("2026-09-28", "zh-CN", { weekday: true })).toBe("9月28日 周一");
    expect(dayLabel("2026-09-28", "en", { weekday: true })).toBe("Mon, Sep 28");
    expect(dayLabel("2026-09-28", "en", { relative: true, today: "2026-09-29" })).toBe("Yesterday");
    expect(dayLabel("2026-09-29", "zh-CN", { relative: true, today: "2026-09-29" })).toBe("今天");
  });

  it("checks dates and whole months, leap years included", () => {
    expect(isDateString("2024-02-29")).toBe(true);
    expect(isDateString("2026-02-29")).toBe(false);
    expect(wholeMonthCount("2024-02-01", "2024-02-29")).toBe(1);
    expect(wholeMonthCount("2024-02-01", "2024-02-28")).toBeNull();
  });
});
