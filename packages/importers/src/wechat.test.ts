import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWechat } from "./wechat";
import { bucketTotals } from "./util/reconcile";

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/wechat/${name}`, import.meta.url));

type Row = Awaited<ReturnType<typeof parseWechat>>["rows"][number];
const view = (rows: Row[]) =>
  rows.map(({ raw: _raw, source: _s, currency: _c, originalAmountMinor: _o, originalCurrency: _oc, status: _st, ...r }) => r);

const xlsx = await parseWechat(fixture("wechat-sample.xlsx"), "wechat-sample.xlsx");
const legacy = await parseWechat(fixture("wechat-legacy-sample.csv"), "wechat-legacy-sample.csv");

describe("parseWechat xlsx (synthetic fixture)", () => {
  const result = xlsx;

  it("reads the declared summary and period", () => {
    expect(result.declared).toEqual({
      count: 9,
      income: { count: 3, minor: 27118 },
      expense: { count: 5, minor: 160419 },
      neutral: { count: 1, minor: 10010 },
    });
    expect(result.periodStart).toBe("2026-09-01T00:00:00+08:00");
    expect(result.periodEnd).toBe("2026-09-29T23:59:59+08:00");
    expect(result.warnings).toEqual([]);
  });

  it("normalizes every row", () => {
    expect(view(result.rows)).toEqual([
      { lineNo: 1, externalId: "4200000001202609280000000001", occurredAt: "2026-09-28T13:56:21+08:00", amountMinor: -3650, direction: "out", kind: "expense", counterparty: "示例餐厅", description: "午餐套餐", sourceCategory: "商户消费", paymentMethod: "招商银行储蓄卡(2222)" },
      { lineNo: 2, externalId: "4200000002202609270000000002", occurredAt: "2026-09-27T19:02:08+08:00", amountMinor: -5888, direction: "out", kind: "expense", counterparty: "示例外卖", description: "晚餐订单", sourceCategory: "商户消费", paymentMethod: "零钱" },
      { lineNo: 3, externalId: "50300000022026092700000000000002", occurredAt: "2026-09-27T21:30:00+08:00", amountMinor: 5888, direction: "in", kind: "refund", counterparty: "示例外卖", description: "/", sourceCategory: "示例外卖-退款", paymentMethod: "零钱" },
      { lineNo: 4, externalId: "1000050001202609260000000003", occurredAt: "2026-09-26T08:15:45+08:00", amountMinor: -150000, direction: "out", kind: "expense", counterparty: "室友甲", description: "转账备注:房租", sourceCategory: "转账", paymentMethod: "零钱" },
      { lineNo: 5, externalId: "1000050001202609250000000004", occurredAt: "2026-09-25T22:10:00+08:00", amountMinor: 20000, direction: "in", kind: "income", counterparty: "室友乙", description: "/", sourceCategory: "转账", paymentMethod: null },
      { lineNo: 6, externalId: "10000499012026092400000000005", occurredAt: "2026-09-24T12:00:00+08:00", amountMinor: -880, direction: "out", kind: "expense", counterparty: "朋友丙", description: "/", sourceCategory: "微信红包（单发）", paymentMethod: "零钱" },
      { lineNo: 7, externalId: "4200000003202609230000000006", occurredAt: "2026-09-23T07:07:07+08:00", amountMinor: -1, direction: "out", kind: "expense", counterparty: "示例公益", description: "分分捐", sourceCategory: "分分捐", paymentMethod: "零钱" },
      { lineNo: 8, externalId: "100003990120260922000000000007", occurredAt: "2026-09-22T16:45:30+08:00", amountMinor: 1230, direction: "in", kind: "income", counterparty: "路人丁", description: "/", sourceCategory: "二维码收款", paymentMethod: null },
      { lineNo: 9, externalId: "3900000000202609210000000008", occurredAt: "2026-09-21T10:00:00+08:00", amountMinor: -10010, direction: "neutral", kind: "transfer", counterparty: "招商银行(2222)", description: "/", sourceCategory: "零钱提现", paymentMethod: "招商银行(2222)" },
    ]);
    for (const r of result.rows) {
      expect(r).toMatchObject({ source: "wechat", currency: "CNY", status: "ok", originalAmountMinor: null, originalCurrency: null });
    }
  });

  it("renders raw cells as text (time as shown in the sheet, empty cells as empty strings)", () => {
    expect(result.rows[3]!.raw).toEqual({
      交易时间: "2026-09-26 08:15:45",
      交易类型: "转账",
      交易对方: "室友甲",
      商品: "转账备注:房租",
      "收/支": "支出",
      "金额(元)": "1500",
      支付方式: "零钱",
      当前状态: "对方已收钱",
      交易单号: "1000050001202609260000000003",
      商户单号: "",
      备注: "/",
    });
  });

  it("reconciles with the declared totals", () => {
    expect(bucketTotals(result.rows)).toEqual(result.declared);
  });
});

describe("parseWechat legacy CSV (UTF-8 BOM, ¥ amounts, quoted cells)", () => {
  const result = legacy;

  it("normalizes every row", () => {
    expect(result.warnings).toEqual([]);
    expect(result.periodStart).toBe("2019-02-01T00:00:00+08:00");
    expect(view(result.rows)).toEqual([
      { lineNo: 1, externalId: "4200000009201903020000000001", occurredAt: "2019-03-02T18:30:05+08:00", amountMinor: -3200, direction: "out", kind: "expense", counterparty: "示例咖啡", description: "拿铁, 大杯", sourceCategory: "商户消费", paymentMethod: "零钱" },
      { lineNo: 2, externalId: "1000050001201903010000000002", occurredAt: "2019-03-01T09:00:00+08:00", amountMinor: 100000, direction: "in", kind: "income", counterparty: "朋友戊", description: "/", sourceCategory: "转账", paymentMethod: null },
      { lineNo: 3, externalId: "3900000000201902280000000003", occurredAt: "2019-02-28T20:00:00+08:00", amountMinor: -5005, direction: "neutral", kind: "transfer", counterparty: "招商银行(3333)", description: "/", sourceCategory: "零钱提现", paymentMethod: "招商银行(3333)" },
    ]);
    expect(result.rows[0]!.raw["金额(元)"]).toBe("¥32.00");
  });

  it("reconciles with the declared totals", () => {
    expect(bucketTotals(result.rows)).toEqual(result.declared);
  });
});
