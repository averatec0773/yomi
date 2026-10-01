import { describe, expect, it } from "vitest";
import { clockNow } from "./clock";
import { todayIn } from "./zone";

const PINNED = "2026-09-30T12:00:00-05:00";

describe("clockNow", () => {
  it("is the real clock without the e2e guard, even when YOMI_E2E_NOW is set", () => {
    for (const env of [{}, { YOMI_E2E_NOW: PINNED }, { YOMI_E2E: "0", YOMI_E2E_NOW: PINNED }, { YOMI_E2E: "true", YOMI_E2E_NOW: PINNED }]) {
      const before = Date.now();
      const t = clockNow(env).getTime();
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(Date.now());
    }
  });

  it("pins to YOMI_E2E_NOW under YOMI_E2E=1, and todayIn follows it", () => {
    const now = clockNow({ YOMI_E2E: "1", YOMI_E2E_NOW: PINNED });
    expect(now.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(todayIn("America/Chicago", now)).toBe("2026-09-30");
    expect(todayIn("Asia/Shanghai", now)).toBe("2026-10-01");
  });

  it("is the real clock under YOMI_E2E=1 with no YOMI_E2E_NOW, and refuses a value that is not an instant", () => {
    expect(Math.abs(clockNow({ YOMI_E2E: "1" }).getTime() - Date.now())).toBeLessThan(1000);
    expect(() => clockNow({ YOMI_E2E: "1", YOMI_E2E_NOW: "yesterday" })).toThrow(/YOMI_E2E_NOW/);
  });
});
