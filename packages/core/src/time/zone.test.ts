import { describe, expect, it } from "vitest";
import { isTimeZone, localDate, occurredOnFor, occurredTimeFor, todayIn, zonedParts } from "./zone";

const CHI = "America/Chicago";

describe("localDate", () => {
  it("moves a Beijing morning to the previous Chicago day, across local midnight", () => {
    // 08:30 Beijing = 19:30 CDT the day before (the card purchase on the evening of the 17th).
    expect(localDate("2026-09-18T08:30:00+08:00", CHI)).toBe("2026-09-17");
    expect(localDate("2026-09-18T12:59:59+08:00", CHI)).toBe("2026-09-17");
    expect(localDate("2026-09-18T13:00:00+08:00", CHI)).toBe("2026-09-18");
    expect(localDate("2026-09-18T23:59:59+08:00", CHI)).toBe("2026-09-18");
    // Beijing just after its own midnight: still the previous afternoon in Chicago.
    expect(localDate("2026-10-01T00:10:00+08:00", CHI)).toBe("2026-09-30");
  });

  it("follows DST: CST (UTC-6) before 2026-03-08, CDT (UTC-5) after", () => {
    expect(localDate("2026-03-08T13:59:59+08:00", CHI)).toBe("2026-03-07"); // 23:59:59 CST
    expect(localDate("2026-03-08T14:00:00+08:00", CHI)).toBe("2026-03-08"); // 00:00 CST
    expect(localDate("2026-03-09T12:59:59+08:00", CHI)).toBe("2026-03-08"); // 23:59:59 CDT
    expect(localDate("2026-03-09T13:00:00+08:00", CHI)).toBe("2026-03-09"); // 00:00 CDT
  });

  it("follows DST back: CDT until 2026-11-01 02:00, then CST", () => {
    expect(localDate("2026-11-01T12:59:59+08:00", CHI)).toBe("2026-10-31"); // 23:59:59 CDT
    expect(localDate("2026-11-01T13:00:00+08:00", CHI)).toBe("2026-11-01"); // 00:00 CDT
    expect(localDate("2026-11-02T13:30:00+08:00", CHI)).toBe("2026-11-01"); // 23:30 CST
    expect(localDate("2026-11-02T14:00:00+08:00", CHI)).toBe("2026-11-02"); // 00:00 CST
    expect(zonedParts("2026-11-01T14:30:00+08:00", CHI)?.time).toBe("01:30:00");
  });

  it("keeps the stated date of a value without an instant", () => {
    expect(localDate("2026-09-18", CHI)).toBe("2026-09-18");
    expect(localDate("2026-09-18T08:30:00", CHI)).toBe("2026-09-18");
    expect(localDate("2026-09-18T01:00:00Z", CHI)).toBe("2026-09-17");
  });
});

describe("occurredOnFor", () => {
  it("converts timed sources and keeps date-only sources' stated date", () => {
    expect(occurredOnFor("2026-09-18T08:30:00+08:00", "icbc_pdf", CHI)).toBe("2026-09-17");
    expect(occurredOnFor("2026-09-18T08:30:00+08:00", "sms", CHI)).toBe("2026-09-17");
    expect(occurredOnFor("2026-09-18T08:30:00+08:00", "alipay", "Asia/Shanghai")).toBe("2026-09-18");
    // BoA / Plaid post dates and manual entries carry a noon marker: the date is the date in any zone.
    expect(occurredOnFor("2026-09-17T12:00:00-05:00", "plaid", "Asia/Shanghai")).toBe("2026-09-17");
    expect(occurredOnFor("2026-09-17T12:00:00-05:00", "boa_csv", "Asia/Tokyo")).toBe("2026-09-17");
    expect(occurredOnFor("2026-09-17T12:00:00+08:00", "manual", CHI)).toBe("2026-09-17");
  });

  it("gives the matching local time", () => {
    expect(occurredTimeFor("2026-09-18T08:30:00+08:00", "icbc_pdf", CHI)).toBe("19:30:00");
    expect(occurredTimeFor("2026-09-17T12:00:00+08:00", "manual", CHI)).toBe("12:00:00");
  });
});

describe("zone names", () => {
  it("accepts IANA names and rejects anything else", () => {
    expect(isTimeZone("America/Chicago")).toBe(true);
    expect(isTimeZone("Asia/Shanghai")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(42)).toBe(false);
  });

  it("todayIn reads the calendar day in the zone", () => {
    const now = new Date("2026-09-18T02:00:00Z");
    expect(todayIn(CHI, now)).toBe("2026-09-17");
    expect(todayIn("Asia/Shanghai", now)).toBe("2026-09-18");
  });
});
