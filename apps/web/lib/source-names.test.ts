import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { zhCN } from "../i18n/zh-CN";
import { distinctSourceNames } from "./source-names";

describe("distinctSourceNames", () => {
  it("names both sides when one bank arrives through Plaid and a file", () => {
    const fresh = [
      { source: "plaid" as const, label: "Bank of America" },
      { source: "boa_csv" as const, label: null },
      { source: "icbc_pdf" as const, label: null },
      { source: "plaid_investments" as const, label: "Robinhood" },
    ];
    expect(distinctSourceNames(fresh, en).map((f) => f.label)).toEqual(["Bank of America (Plaid)", "Bank of America (CSV)", null, "Robinhood"]);
    expect(distinctSourceNames(fresh, zhCN).map((f) => f.label)).toEqual(["Bank of America（Plaid 同步）", "美国银行（CSV 导入）", null, "Robinhood"]);
  });

  it("leaves names alone when no institution appears twice", () => {
    const fresh = [
      { source: "plaid" as const, label: "Pine Credit Union" },
      { source: "boa_csv" as const, label: null },
    ];
    expect(distinctSourceNames(fresh, en)).toEqual(fresh);
  });
});
