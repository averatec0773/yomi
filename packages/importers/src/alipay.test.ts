import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAlipay } from "./alipay";
import { bucketTotals } from "./util/reconcile";

const fixture = readFileSync(new URL("../test/fixtures/alipay/alipay-sample.csv", import.meta.url));

describe("parseAlipay (synthetic fixture, GBK, CRLF preamble + LF rows)", () => {
  const result = parseAlipay(fixture);

  it("reads the declared summary and period", () => {
    expect(result.declared).toEqual({
      count: 8,
      income: { count: 2, minor: 15500 },
      expense: { count: 4, minor: 134550 },
      neutral: { count: 2, minor: 4567 },
    });
    expect(result.periodStart).toBe("2026-09-01T00:00:00+08:00");
    expect(result.periodEnd).toBe("2026-09-30T23:59:59+08:00");
    expect(result.warnings).toEqual([]);
  });

  it("normalizes every row", () => {
    const view = result.rows.map(({ raw: _raw, source: _s, currency: _c, originalAmountMinor: _o, originalCurrency: _oc, ...r }) => r);
    expect(view).toEqual([
      { lineNo: 1, externalId: "2026092822001100000000000001", occurredAt: "2026-09-28T20:15:03+08:00", amountMinor: -2350, direction: "out", kind: "expense", status: "ok", counterparty: "示例便利店", description: "矿泉水和纸巾", sourceCategory: "日用百货", paymentMethod: "账户余额" },
      { lineNo: 2, externalId: "2026092722001100000000000002", occurredAt: "2026-09-27T12:01:44+08:00", amountMinor: -8800, direction: "out", kind: "expense", status: "ok", counterparty: "Sample Cinema Co.", description: "Sample Cinema Co.", sourceCategory: "文化休闲", paymentMethod: "工商银行信用卡(0000)&工商银行立减金" },
      { lineNo: 3, externalId: "2026092522001100000000000003", occurredAt: "2026-09-25T09:30:00+08:00", amountMinor: -4560, direction: "out", kind: "expense", status: "closed", counterparty: "示例网店", description: "收纳盒 两件装", sourceCategory: "日用百货", paymentMethod: "中国银行储蓄卡(1111)" },
      { lineNo: 4, externalId: "2026092522001100000000000003_2026092500000000000000000009", occurredAt: "2026-09-25T18:42:10+08:00", amountMinor: 4560, direction: "neutral", kind: "transfer", status: "ok", counterparty: "示例网店", description: "退款-收纳盒 两件装", sourceCategory: "退款", paymentMethod: "中国银行储蓄卡(1111)" },
      { lineNo: 5, externalId: "20260924000000000000000000000004", occurredAt: "2026-09-24T00:05:12+08:00", amountMinor: 7, direction: "neutral", kind: "income", status: "ok", counterparty: "示例基金销售有限公司", description: "余额宝-2026.09.23-收益发放", sourceCategory: "投资理财", paymentMethod: null },
      { lineNo: 6, externalId: "2026092020001000000000000005", occurredAt: "2026-09-20T16:20:00+08:00", amountMinor: 15000, direction: "in", kind: "income", status: "ok", counterparty: "测**", description: "转账收款", sourceCategory: "收入", paymentMethod: "账户余额(个人余额)" },
      { lineNo: 7, externalId: "2026091820001000000000000006", occurredAt: "2026-09-18T11:11:11+08:00", amountMinor: 500, direction: "in", kind: "income", status: "ok", counterparty: "示例平台", description: "活动奖励", sourceCategory: "收入", paymentMethod: "账户余额" },
      { lineNo: 8, externalId: "2026091522001100000000000007", occurredAt: "2026-09-15T08:00:59+08:00", amountMinor: -123400, direction: "out", kind: "expense", status: "ok", counterparty: "示例服饰旗舰店", description: "T恤 白色 L", sourceCategory: "服饰装扮", paymentMethod: "中国银行储蓄卡(1111)&优惠" },
    ]);
    for (const r of result.rows) {
      expect(r).toMatchObject({ source: "alipay", currency: "CNY", originalAmountMinor: null, originalCurrency: null });
    }
  });

  it("keeps the raw row verbatim, keyed by header, without the trailing empty column", () => {
    expect(result.rows[0]!.raw).toEqual({
      交易时间: "2026-09-28 20:15:03",
      交易分类: "日用百货",
      交易对方: "示例便利店",
      对方账号: "/",
      商品说明: "矿泉水和纸巾",
      "收/支": "支出",
      金额: "23.50",
      "收/付款方式": "账户余额",
      交易状态: "交易成功",
      交易订单号: "2026092822001100000000000001\t",
      商家订单号: "T20260928000001\t",
      备注: "",
    });
  });

  it("reconciles with the declared totals (closed rows count but add no amount)", () => {
    expect(bucketTotals(result.rows)).toEqual(result.declared);
  });
});
