import { describe, expect, it } from "vitest";
import { decimalToMinor, divRound, minorToDecimal, normalizeDecimal, numberToDecimal, productToMinor } from "./decimal";
import { parseXml, XmlParseError } from "./xml";

describe("decimal strings", () => {
  it("normalizes without floats", () => {
    expect(normalizeDecimal("0010.500")).toBe("10.5");
    expect(normalizeDecimal("-0.000")).toBe("0");
    expect(normalizeDecimal("+1,234.5678")).toBe("1234.5678");
    expect(normalizeDecimal(".25")).toBe("0.25");
    expect(() => normalizeDecimal("1e3")).toThrow();
    expect(() => normalizeDecimal("")).toThrow();
  });

  it("converts to minor units with one half-away-from-zero rounding", () => {
    expect(decimalToMinor("2384.7957")).toBe(238480);
    expect(decimalToMinor("2000.123456")).toBe(200012);
    expect(decimalToMinor("0.005")).toBe(1);
    expect(decimalToMinor("-0.005")).toBe(-1);
    expect(decimalToMinor("-0.004")).toBe(0);
    expect(decimalToMinor("4102.335")).toBe(410234);
    expect(decimalToMinor("157", 0)).toBe(157);
    expect(decimalToMinor("12.5", 0)).toBe(13);
  });

  it("multiplies fractional shares by 4-decimal prices before rounding once", () => {
    // 0.333 × 227.1234 = 75.6320922 → 7563 cents; rounding the price first would drift.
    expect(productToMinor(["0.333", "227.1234"])).toBe(7563);
    expect(productToMinor(["2", "3.45", "100"])).toBe(69000);
    expect(productToMinor(["-47.74104242992852", "27.53"])).toBe(-131431);
  });

  it("keeps a double's shortest decimal text, expanding exponents", () => {
    expect(numberToDecimal(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(numberToDecimal(-47.74104242992852)).toBe("-47.74104242992852");
    expect(numberToDecimal(1e-7)).toBe("0.0000001");
    expect(numberToDecimal(1.5e21)).toBe("1500000000000000000000");
    expect(numberToDecimal(-0)).toBe("0");
    expect(() => numberToDecimal(NaN)).toThrow();
  });

  it("divides with rounding half away from zero and formats minor units", () => {
    expect(divRound(5n, 10n)).toBe(1n);
    expect(divRound(-5n, 10n)).toBe(-1n);
    expect(divRound(4n, 10n)).toBe(0n);
    expect(minorToDecimal(-12345)).toBe("-123.45");
  });
});

describe("parseXml", () => {
  it("reads attributes, entities, text and CDATA", () => {
    const x = parseXml(`<?xml version="1.0"?><!-- c --><a k="1 &amp; 2" j='&#65;'><b>t &lt;x&gt;</b><c><![CDATA[<raw>]]></c><d/></a>`);
    expect(x.name).toBe("a");
    expect(x.attrs).toEqual({ k: "1 & 2", j: "A" });
    expect(x.children.map((c) => [c.name, c.text])).toEqual([
      ["b", "t <x>"],
      ["c", "<raw>"],
      ["d", ""],
    ]);
  });

  it("rejects DOCTYPE, unknown entities and broken nesting", () => {
    expect(() => parseXml(`<!DOCTYPE a [<!ENTITY x "y">]><a/>`)).toThrow(XmlParseError);
    expect(() => parseXml(`<a k="&x;"/>`)).toThrow(XmlParseError);
    expect(() => parseXml(`<a><b></a>`)).toThrow(XmlParseError);
    expect(() => parseXml(`<a>`)).toThrow(XmlParseError);
  });
});
