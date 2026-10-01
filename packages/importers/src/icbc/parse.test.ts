import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIcbcItems, type TextItem } from "./parse";

// Geometry taken from the real statement; dates, amounts, merchants and card number are invented.
const pages = JSON.parse(
  readFileSync(new URL("../../test/fixtures/icbc/items.json", import.meta.url), "utf8"),
) as TextItem[][];

describe("parseIcbcItems", () => {
  const result = parseIcbcItems(pages);
  const { rows, declared } = result;

  it("fixture keeps the diagonal watermark over the table", () => {
    expect(pages.flat().filter((it) => it.angle !== 0).length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  it("parses one row per transaction and reconciles with the page footers", () => {
    expect(rows).toHaveLength(14);
    expect(declared.count).toBe(14);
    const out = rows.filter((r) => r.direction === "out");
    const inn = rows.filter((r) => r.direction === "in");
    expect(declared.expense).toEqual({ count: out.length, minor: out.reduce((s, r) => s - r.amountMinor, 0) });
    expect(declared.income).toEqual({ count: inn.length, minor: inn.reduce((s, r) => s + r.amountMinor, 0) });
    expect(declared.expense?.minor).toBe(40173 + 62918);
    expect(declared.income?.minor).toBe(49141 + 21109);
    expect(rows.map((r) => r.lineNo)).toEqual(rows.map((_, i) => i + 1));
  });

  it("reads the statement period", () => {
    expect(result.periodStart).toBe("2025-02-17");
    expect(result.periodEnd).toBe("2025-08-20");
  });

  it("maps an expense with a foreign transaction currency", () => {
    expect(rows[0]).toMatchObject({
      source: "icbc_pdf",
      lineNo: 1,
      externalId: null,
      occurredAt: "2025-02-17T08:00:00+08:00",
      amountMinor: -104,
      currency: "USD",
      originalAmountMinor: -741,
      originalCurrency: "HKD",
      direction: "out",
      kind: "expense",
      status: "ok",
      counterparty: "NORTHWIND GROCERY",
      description: "消费",
      sourceCategory: "消费",
      paymentMethod: "工商银行信用卡(1234)",
    });
  });

  it("joins a merchant wrapped over two visual lines", () => {
    expect(rows[1]?.counterparty).toBe("HARBOR NOODLE HOUSE SEATTLE WA");
    expect(rows[1]?.occurredAt).toBe("2025-02-18T09:05:01+08:00");
  });

  it("books HKD rows in HKD", () => {
    expect(rows[2]).toMatchObject({ currency: "HKD", amountMinor: -5337, originalAmountMinor: null });
  });

  it("maps 贷 退货 to refund and other 贷 to transfer", () => {
    expect(rows[3]).toMatchObject({ direction: "in", kind: "refund", amountMinor: 6132, description: "退货" });
    expect(rows[8]).toMatchObject({ direction: "in", kind: "transfer", amountMinor: 21109, description: "还款" });
  });

  it("maps a 贷 rebate or cashback row to income, not refund", () => {
    const edited = pages.map((page) =>
      page.map((it) => (it.str === "PIXEL BOOKS" ? { ...it, str: "PIXEL CASHBACK REBATE" } : it)),
    );
    const r = parseIcbcItems(edited);
    expect(r.warnings).toEqual([]);
    expect(r.rows[5]).toMatchObject({ direction: "in", kind: "income", counterparty: "PIXEL CASHBACK REBATE" });
    expect(r.rows[4]).toMatchObject({ kind: "refund" });
    expect(r.declared).toEqual(declared);
  });

  it("keeps the raw cells with the card masked to its last four digits", () => {
    expect(rows[1]?.raw).toEqual({
      入账日期: "2025-02-18 09:05:01",
      交易卡号: "****1234",
      "收/支": "借",
      交易币种: "美元",
      交易金额: "149.81",
      入账币种: "美元",
      入账金额: "149.81",
      账户余额: "-1,244.56",
      对方户名: "",
      对方账号: "",
      摘要: "消费",
      交易场所: "HARBOR NOODLE HOUSE SEATTLE WA",
    });
    for (const r of rows) expect(JSON.stringify(r)).not.toContain("6222000000001234");
  });

  it("warns when a page's parsed count disagrees with its footer", () => {
    const first = pages[0] ?? [];
    const lastCard = first.filter((it) => it.str === "6222000000001234").at(-1);
    const damaged = first.filter((it) => it !== lastCard);
    const r = parseIcbcItems([damaged]);
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: "import_page_count_mismatch", params: expect.objectContaining({ declared: 8 }) }));
  });
});
