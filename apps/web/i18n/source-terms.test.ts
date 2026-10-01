import { describe, expect, it } from "vitest";
import { en } from "./en";
import { bankDescriptionAddsNothing, displayDescription, sourceTermLabel } from "./source-terms";
import { zhCN } from "./zh-CN";

describe("sourceTermLabel", () => {
  it("shows fixed statement terms in English and hides empty ones", () => {
    const cases: [string, string | null][] = [
      ["消费", null],
      ["/", null],
      ["退货", "Refund"],
      ["商户消费", "Merchant payment"],
      ["微信红包（单发）", "WeChat red packet (one person)"],
      ["微信红包(群红包)", "WeChat red packet (group)"],
      ["转账-退款", "Transfer refund"],
      ["微信红包-退款", "WeChat red packet refund"],
      ["餐饮美食", "Food and dining"],
      ["商业服务", "Business services"],
      ["拿铁, 大杯", "拿铁, 大杯"],
      ["某某-退款", "某某-退款"],
      ["", null],
    ];
    for (const [term, want] of cases) expect(sourceTermLabel(term, en)).toBe(want);
  });

  it("shows stored text in Chinese", () => {
    expect(sourceTermLabel("消费", zhCN)).toBe("消费");
    expect(sourceTermLabel("商户消费", zhCN)).toBe("商户消费");
  });

  it("every English term is plain English", () => {
    for (const v of Object.values(en.sourceTerms.terms)) expect(v).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("displayDescription", () => {
  it("drops descriptions that repeat or add nothing to the merchant", () => {
    expect(displayDescription({ source: "icbc_pdf", merchant: "Blue Heron Cafe", description: "消费" }, en)).toBeNull();
    expect(displayDescription({ source: "icbc_pdf", merchant: "Blue Heron Cafe", description: "消费" }, zhCN)).toBe("消费");
    expect(displayDescription({ source: "icbc_pdf", merchant: "", description: "退货" }, en)).toBe("Refund");
    expect(displayDescription({ source: "manual", merchant: "lunch", description: "lunch" }, en)).toBeNull();
    expect(displayDescription({ source: "boa_csv", merchant: "Sample Bistro", description: "SAMPLE BISTRO SAN FRANCISCO CA SAN FRANCISCO CA" }, en)).toBeNull();
    expect(displayDescription({ source: "boa_csv", merchant: "ANNA", description: "Zelle payment to ANNA Conf# abc123" }, en)).toBe(
      "Zelle payment to ANNA Conf# abc123",
    );
  });
});

describe("bankDescriptionAddsNothing", () => {
  it("ignores dates, boilerplate, numbers and a trailing location", () => {
    expect(bankDescriptionAddsNothing("CHECKCARD 0915 STARBUCKS STORE 1234 SEATTLE WA 24000000000000000000001", "Starbucks Store")).toBe(true);
    expect(bankDescriptionAddsNothing("PURCHASE 09/14 SQ *COFFEE CART AUSTIN TX", "Coffee Cart")).toBe(true);
    expect(bankDescriptionAddsNothing("Uber 063015 SF**POOL**", "Uber")).toBe(true);
    expect(bankDescriptionAddsNothing("ONLINE TRANSFER TO SAVINGS", "Savings")).toBe(false);
    expect(bankDescriptionAddsNothing("SOMETHING ELSE", "")).toBe(false);
  });
});
