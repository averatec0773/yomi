import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

describe("relativeTime", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("reads just now, minutes, hours, days, then a short date", () => {
    expect(relativeTime(ago(30_000), "en", "just now", now)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), "en", "just now", now)).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * 3_600_000), "en", "just now", now)).toBe("3 hours ago");
    expect(relativeTime(ago(26 * 3_600_000), "en", "just now", now)).toBe("yesterday");
    expect(relativeTime(ago(3 * 86_400_000), "zh-CN", "刚刚", now)).toBe("3天前");
    expect(relativeTime(ago(10 * 86_400_000), "en", "just now", now)).toBe("Sep 20");
    expect(relativeTime("not a date", "en", "just now", now)).toBe("not a date");
  });

  it("treats a time slightly in the future as just now", () => {
    expect(relativeTime(new Date(now + 5_000).toISOString(), "en", "just now", now)).toBe("just now");
  });
});
