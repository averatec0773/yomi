import { describe, expect, it } from "vitest";
import { looksLikeIcbcSms, parseIcbcSms, splitMerchantCity } from "./icbc";

const today = "2026-09-29";
const POS = "您尾号3141信用卡9月27日08:24POS支出(消费BUSY BEE BOBA Houston)15.74美元。【工商银行】";
const ONLINE = "您尾号3141信用卡9月27日08:38网上银行支出(消费)14.48美元。【工商银行】";

describe("parseIcbcSms", () => {
  it("reads a POS alert with merchant and city", () => {
    expect(parseIcbcSms(POS, { today })).toMatchObject({
      last4: "3141",
      occurredAt: "2026-09-27T08:24:00+08:00",
      channel: "POS",
      directionWord: "支出",
      summary: "消费",
      merchant: "BUSY BEE BOBA",
      city: "Houston",
      amountMinor: -1574,
      currency: "USD",
      direction: "out",
      kind: "expense",
      text: POS,
    });
  });

  it("reads an online alert without a merchant", () => {
    expect(parseIcbcSms(ONLINE, { today })).toMatchObject({
      occurredAt: "2026-09-27T08:38:00+08:00",
      channel: "网上银行",
      summary: "消费",
      merchant: "",
      city: null,
      amountMinor: -1448,
      kind: "expense",
    });
  });

  it("reads currencies, thousands separators and full-width punctuation", () => {
    const hkd = parseIcbcSms("您尾号3141信用卡9月1日10:05POS支出（消费MTR SHOP）1,200.50港币，可用额度12,000.00元。【工商银行】", { today });
    expect(hkd).toMatchObject({ amountMinor: -120050, currency: "HKD", merchant: "MTR SHOP", city: null });
    expect(parseIcbcSms("您尾号3141信用卡9月1日10:05快捷支付支出(消费美团)35.00元。【工商银行】", { today })).toMatchObject({
      currency: "CNY",
      merchant: "美团",
      channel: "快捷支付",
    });
    expect(parseIcbcSms("您尾号3141信用卡9月1日10:05POS支出(消费X)5人民币。【工商银行】", { today })?.currency).toBe("CNY");
  });

  it("books credits: refunds, repayments and rebates", () => {
    expect(parseIcbcSms("您尾号3141信用卡9月28日10:02退货收入(退货BUSY BEE BOBA Houston)15.74美元。【工商银行】", { today })).toMatchObject({
      amountMinor: 1574,
      direction: "in",
      kind: "refund",
      summary: "退货",
      merchant: "BUSY BEE BOBA",
    });
    expect(parseIcbcSms("您尾号3141信用卡9月28日10:02存入(还款)500.00美元。【工商银行】", { today })).toMatchObject({
      amountMinor: 50000,
      kind: "transfer",
      summary: "还款",
    });
    expect(parseIcbcSms("您尾号3141信用卡9月28日10:02收入(CASHBACK REBATE)1.00美元。【工商银行】", { today })?.kind).toBe("income");
  });

  it("puts a date after today (plus a day) in the previous year", () => {
    expect(parseIcbcSms(POS, { today: "2027-01-03" })?.occurredAt).toBe("2026-09-27T08:24:00+08:00");
    expect(parseIcbcSms(POS, { today: "2026-09-26" })?.occurredAt).toBe("2026-09-27T08:24:00+08:00");
    expect(parseIcbcSms(POS, { today: "2026-09-25" })?.occurredAt).toBe("2025-09-27T08:24:00+08:00");
  });

  it("rejects other text and impossible values", () => {
    expect(parseIcbcSms("lunch 35 @roommate", { today })).toBeNull();
    expect(parseIcbcSms("您尾号3141信用卡2月30日08:24POS支出(消费X)1.00美元。【工商银行】", { today })).toBeNull();
    expect(parseIcbcSms("您尾号3141信用卡9月27日08:24POS支出(消费X)0.00美元。【工商银行】", { today })).toBeNull();
    expect(looksLikeIcbcSms("您尾号3141卡9月27日08:24快捷支付支出15.74元。【工商银行】")).toBe(true);
    expect(looksLikeIcbcSms("lunch 35")).toBe(false);
  });
});

describe("splitMerchantCity", () => {
  it("splits Title-case trailing words off an all-caps name only", () => {
    expect(splitMerchantCity("BUSY BEE BOBA Houston")).toEqual({ merchant: "BUSY BEE BOBA", city: "Houston" });
    expect(splitMerchantCity("HEB #123 San Antonio")).toEqual({ merchant: "HEB #123", city: "San Antonio" });
    expect(splitMerchantCity("Starbucks Store")).toEqual({ merchant: "Starbucks Store", city: null });
    expect(splitMerchantCity("COSTCO WHSE")).toEqual({ merchant: "COSTCO WHSE", city: null });
    expect(splitMerchantCity("")).toEqual({ merchant: "", city: null });
  });
});
