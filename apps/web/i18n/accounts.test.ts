import { describe, expect, it } from "vitest";
import { accountLabel } from "./accounts";
import { en } from "./en";
import { zhCN } from "./zh-CN";

describe("accountLabel", () => {
  it("shows core's Chinese account names in English", () => {
    const cases: [string, string][] = [
      ["支付宝余额", "Alipay balance"],
      ["微信零钱", "WeChat balance"],
      ["手动记账", "Manual entries"],
      ["Bank of America 支票", "Bank of America checking"],
      ["Bank of America 信用卡", "Bank of America credit card"],
      ["工商银行信用卡 3141", "ICBC credit card 3141"],
      ["中国银行储蓄卡 5501", "Bank of China debit card 5501"],
      ["招商银行借记卡 0001", "China Merchants Bank debit card 0001"],
      ["工商银行信用卡", "ICBC credit card"],
      ["某某银行信用卡 1234", "某某银行 credit card 1234"],
      ["Chase Sapphire 4321", "Chase Sapphire 4321"],
    ];
    for (const [stored, shown] of cases) expect(accountLabel(stored, en)).toBe(shown);
  });

  it("keeps the stored name in Chinese", () => {
    for (const n of ["支付宝余额", "工商银行信用卡 3141", "Bank of America 支票", "Chase 4321"]) expect(accountLabel(n, zhCN)).toBe(n);
  });
});
