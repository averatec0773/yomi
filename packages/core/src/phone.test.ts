import { describe, expect, it } from "vitest";
import {
  countryForTimeZone,
  formatNationalTyping,
  formatPhone,
  isE164Phone,
  parsePhone,
  phoneCountry,
  phoneFieldText,
  phoneHref,
  typePhone,
  upgradePhone,
} from "./phone";

// Fictional numbers only: US 202-555-0143, China 138 0013 8000 (a documented example).
describe("phone numbers", () => {
  it("parses a national number for the chosen country, or an international one, to E.164", () => {
    expect(parsePhone("202-555-0143", "US")).toEqual({ e164: "+12025550143", country: "US", nationalNumber: "2025550143" });
    expect(parsePhone("(202) 555-0143")).toMatchObject({ e164: "+12025550143", country: "US" });
    expect(parsePhone("138 0013 8000", "CN")).toEqual({ e164: "+8613800138000", country: "CN", nationalNumber: "13800138000" });
    // The "+" wins over the chosen country.
    expect(parsePhone("+86 138 0013 8000", "US")).toMatchObject({ e164: "+8613800138000", country: "CN" });
    // Incomplete, or not valid for the chosen country.
    expect(parsePhone("202-555", "US")).toBeNull();
    expect(parsePhone("138 0013 8000", "US")).toBeNull();
    expect(parsePhone("+1 555 010 0100")).toBeNull();
    expect(parsePhone("call me")).toBeNull();
    expect(isE164Phone("+12025550143")).toBe(true);
    expect(isE164Phone("202-555-0143")).toBe(false);
    expect(isE164Phone("+15550100100")).toBe(false);
  });

  it("formats per country: US national (with +1 on a statement in another currency), China and others international", () => {
    expect(formatPhone("+12025550143")).toBe("202-555-0143");
    expect(formatPhone("+12025550143", { currency: "USD" })).toBe("202-555-0143");
    expect(formatPhone("+12025550143", { currency: "CNY" })).toBe("+1 202-555-0143");
    expect(formatPhone("+8613800138000")).toBe("+86 138 0013 8000");
    expect(formatPhone("+8613800138000", { currency: "USD" })).toBe("+86 138 0013 8000");
    // Canada shares +1 but is another country: international.
    expect(formatPhone("+14165550143")).toBe("+1 416 555 0143");
    // Not a valid number: as typed.
    expect(formatPhone(" +1 555 010 0100 ")).toBe("+1 555 010 0100");
    expect(formatPhone("13800138000")).toBe("13800138000");
    expect(phoneHref("+12025550143")).toBe("tel:+12025550143");
    expect(phoneHref("+1 555 010 0100")).toBeNull();
  });

  it("upgrades a stored value typed before v0.1.30: read as US without a +, kept as typed when not a valid number", () => {
    expect(upgradePhone("(202) 555-0143")).toBe("+12025550143");
    expect(upgradePhone("202.555.0143")).toBe("+12025550143");
    expect(upgradePhone("+1 202 555 0143")).toBe("+12025550143");
    expect(upgradePhone("+86 138 0013 8000")).toBe("+8613800138000");
    expect(upgradePhone("+12025550143")).toBe("+12025550143");
    // A Chinese mobile without "+86" does not read as a US number: kept for "Check this number".
    expect(upgradePhone(" 13800138000 ")).toBe("13800138000");
    expect(upgradePhone("+1 555 010 0100")).toBe("+1 555 010 0100");
  });

  it("defaults the picker to the stored number's country, else the time zone's, else US", () => {
    expect(countryForTimeZone("America/Chicago")).toBe("US");
    expect(countryForTimeZone("America/Los_Angeles")).toBe("US");
    expect(countryForTimeZone("Asia/Shanghai")).toBe("CN");
    expect(countryForTimeZone("Europe/London")).toBe("US");
    expect(countryForTimeZone(undefined)).toBe("US");
    expect(phoneCountry("+8613800138000", "America/Chicago")).toBe("CN");
    expect(phoneCountry("+12025550143", "Asia/Shanghai")).toBe("US");
    expect(phoneCountry("13800138000", "Asia/Shanghai")).toBe("CN");
    expect(phoneCountry(null, "Asia/Shanghai")).toBe("CN");
    expect(phoneCountry("", "America/New_York")).toBe("US");
  });

  it("formats as typed for the country, and a typed or pasted + number switches the country", () => {
    expect(["2", "202", "2025", "202555", "2025550143"].map((d) => formatNationalTyping(d, "US"))).toEqual([
      "2",
      "202",
      "202-5",
      "202-555",
      "202-555-0143",
    ]);
    expect(formatNationalTyping("13800138000", "CN")).toBe("138 0013 8000");
    expect(formatNationalTyping("01012345678", "CN")).toBe("010 1234 5678");
    expect(formatNationalTyping("2079460958", "GB")).toBe("20 7946 0958");
    expect(typePhone("+44 20 7946 0958", "US")).toEqual({ text: "20 7946 0958", country: "GB" });
    expect(parsePhone("20 7946 0958", "GB")?.e164).toBe("+442079460958");
    expect(formatPhone("+442079460958")).toBe("+44 20 7946 0958");
    expect(typePhone("202 555 0143", "US")).toEqual({ text: "202-555-0143", country: "US" });
    expect(typePhone("+86 138 0013 8000", "US")).toEqual({ text: "138 0013 8000", country: "CN" });
    expect(typePhone("+1 202-555-0143", "CN")).toEqual({ text: "202-555-0143", country: "US" });
    // Until the digits name a country, the international text stays and the country does not change.
    expect(typePhone("+1 202", "CN")).toEqual({ text: "+1 202", country: "CN" });
    expect(phoneFieldText("+12025550143")).toBe("202-555-0143");
    expect(phoneFieldText("+8613800138000")).toBe("138 0013 8000");
    expect(phoneFieldText("+1 555 010 0100")).toBe("+1 555 010 0100");
    expect(phoneFieldText(null)).toBe("");
  });
});
