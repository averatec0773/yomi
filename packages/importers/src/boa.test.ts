import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBoaCsv, parseBoaDescription, zelleCounterparty } from "./boa";
import { detectAndParse, detectSource } from "./index";
import { bucketTotals } from "./util/reconcile";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url)));

describe("parseBoaCsv checking (synthetic, summary block + beginning-balance row, CRLF)", () => {
  const result = parseBoaCsv(fixture("boa/boa-checking-sample.csv"));

  it("skips the beginning-balance row and reconciles with the summary", () => {
    expect(result.source).toBe("boa_csv");
    expect(result.rows).toHaveLength(9);
    expect(result.warnings).toEqual([]);
    expect(result.declared).toEqual({ income: { count: 3, minor: 252500 }, expense: { count: 6, minor: 39700 } });
    const parsed = bucketTotals(result.rows);
    expect(parsed.income).toEqual(result.declared.income);
    expect(parsed.expense).toEqual(result.declared.expense);
    expect(result.periodStart).toBe("2026-09-01T00:00:00-05:00");
    expect(result.periodEnd).toBe("2026-09-08T23:59:59-05:00");
  });

  it("classifies each description shape", () => {
    const view = result.rows.map((r) => [r.occurredAt, r.amountMinor, r.kind, r.sourceCategory, r.counterparty]);
    expect(view).toEqual([
      ["2026-09-02T12:00:00-05:00", -450, "expense", "Purchase", "SAMPLE COFFEE HOUSE"],
      ["2026-09-02T12:00:00-05:00", -450, "expense", "Purchase", "SAMPLE COFFEE HOUSE"],
      ["2026-09-03T12:00:00-05:00", 2500, "income", "Zelle", "ALEX TESTER"],
      ["2026-09-04T12:00:00-05:00", -1200, "expense", "Zelle", "ALEX TESTER"],
      ["2026-09-05T12:00:00-05:00", 200000, "income", "Payroll", "SAMPLE PAYROLL INC"],
      ["2026-09-06T12:00:00-05:00", -30000, "transfer", "Transfer", "Credit card 0000"],
      ["2026-09-07T12:00:00-05:00", 50000, "income", "Wire", "SAMPLE SENDER"],
      ["2026-09-07T12:00:00-05:00", -1600, "expense", "Fee", "Wire Transfer Fee"],
      ["2026-09-08T12:00:00-05:00", -6000, "expense", "Purchase", "SAMPLE MART #123 AUSTIN TX"],
    ]);
    for (const r of result.rows) {
      expect(r).toMatchObject({ currency: "USD", externalId: null, status: "ok", paymentMethod: "Bank of America 支票" });
      expect(r.direction).toBe(r.amountMinor > 0 ? "in" : "out");
    }
  });

  it("keeps the raw row including the running balance", () => {
    expect(result.rows[1]!.raw).toEqual({
      Date: "09/02/2026",
      Description: "SAMPLE COFFEE HOUSE 09/01 PURCHASE SAN JOSE CA",
      Amount: "-4.50",
      "Running Bal.": "991.00",
    });
  });

  it("warns when beginning + Σ ≠ ending", () => {
    const text = new TextDecoder().decode(fixture("boa/boa-checking-sample.csv")).replace('Ending balance as of 09/08/2026,,"3,128.00"', 'Ending balance as of 09/08/2026,,"3,128.01"');
    const r = parseBoaCsv(new TextEncoder().encode(text));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ code: "import_balance_mismatch", params: expect.objectContaining({ endingMinor: 312801 }) });
  });
});

describe("parseBoaCsv credit card (synthetic)", () => {
  const result = parseBoaCsv(fixture("boa/boa-card-sample.csv"));

  it("uses the reference number as the external id and BoA sign convention", () => {
    expect(result.warnings).toEqual([]);
    expect(result.declared).toEqual({});
    const view = result.rows.map((r) => [r.externalId, r.occurredAt.slice(0, 10), r.amountMinor, r.kind, r.sourceCategory]);
    expect(view).toEqual([
      ["24000000000000000000001", "2026-09-03", -4210, "expense", "Purchase"],
      ["24000000000000000000002", "2026-09-05", -1999, "expense", "Purchase"],
      ["24000000000000000000003", "2026-09-06", 1999, "refund", "Purchase"],
      ["24000000000000000000004", "2026-09-10", 30000, "transfer", "Transfer"],
      [null, "2026-09-12", -2500, "expense", "Fee"],
    ]);
    for (const r of result.rows) expect(r.paymentMethod).toBe("Bank of America 信用卡");
  });

  it("warns when a payment is negative (sign convention flipped)", () => {
    const text = new TextDecoder().decode(fixture("boa/boa-card-sample.csv")).replace('"PAYMENT - THANK YOU","",300.00', '"PAYMENT - THANK YOU","",-300.00');
    expect(parseBoaCsv(new TextEncoder().encode(text)).warnings).toHaveLength(1);
  });
});

describe("parseBoaDescription", () => {
  it.each([
    ["Zelle payment from JANE ROE Conf# abc123", 1000, "income", "Zelle", "JANE ROE"],
    ["Zelle payment to JANE ROE for rent; Conf# abc123", -1000, "expense", "Zelle", "JANE ROE"],
    ["Zelle Transfer Conf# abc123; JANE ROE", -1000, "expense", "Zelle", "JANE ROE"],
    ["WIRE TYPE:WIRE OUT DATE:260901 TIME:1200 ET TRN:1 SERVICE REF:1 BNF:SAMPLE PAYEE ID:1 BNF BK:X ID:1", -5000, "expense", "Wire", "SAMPLE PAYEE"],
    ["SAMPLE CARD SERVICES DES:EPAY ID:1 INDN:TEST USER CO ID:1 WEB", -5000, "transfer", "Transfer", "SAMPLE CARD SERVICES"],
    ["SAMPLE BROKERAGE DES:TRANSFER ID:1 INDN:TEST USER CO ID:1 PPD", 5000, "transfer", "Transfer", "SAMPLE BROKERAGE"],
    ["SAMPLE UTILITY DES:payment ID:1 INDN:TEST USER CO ID:1 WEB", -5000, "expense", "ACH", "SAMPLE UTILITY"],
    ["Online Banking transfer to SAV 0000 Confirmation# 1", -5000, "transfer", "Transfer", "Online Banking transfer to SAV 0000"],
    ["BKOFAMERICA ATM 09/01 #000001 WITHDRWL SAMPLE ST SAN JOSE CA", -2000, "transfer", "ATM", "ATM"],
    ["BKOFAMERICA MOBILE 09/01 0000000000 DEPOSIT *MOBILE CA", 2000, "income", "Deposit", "Mobile deposit"],
    ["Interest Earned", 12, "income", "Interest", "Interest Earned"],
    ["SAMPLE STORE 09/01 PURCHASE SAN JOSE CA", 999, "refund", "Purchase", "SAMPLE STORE"],
    ["Something unrecognized", -100, "expense", null, "Something unrecognized"],
  ] as const)("%s", (text, amount, kind, cat, party) => {
    expect(parseBoaDescription(text, amount)).toEqual({ kind, sourceCategory: cat, counterparty: party });
  });

  it("extracts the Zelle party and nothing from non-Zelle text", () => {
    expect(zelleCounterparty("Zelle payment from JANE ROE Conf# x1")).toEqual({ name: "JANE ROE", direction: "from" });
    expect(zelleCounterparty("SAMPLE STORE 09/01 PURCHASE")).toBeNull();
  });
});

describe("detectSource with BoA", () => {
  it("routes BoA checking and card CSVs by content", async () => {
    expect(detectSource(fixture("boa/boa-checking-sample.csv"), "stmt.csv")).toBe("boa_csv");
    expect(detectSource(fixture("boa/boa-card-sample.csv"), "anything.csv")).toBe("boa_csv");
    const headerOnly = new TextEncoder().encode("Date,Description,Amount,Running Bal.\r\n09/02/2026,X 09/01 PURCHASE Y CA,-1.00,1.00\r\n");
    expect(detectSource(headerOnly, "x.csv")).toBe("boa_csv");
    expect((await detectAndParse(fixture("boa/boa-card-sample.csv"), "c.csv")).rows).toHaveLength(5);
  });

  it("keeps Alipay and WeChat detection intact", () => {
    expect(detectSource(fixture("alipay/alipay-sample.csv"), "alipay.csv")).toBe("alipay");
    expect(detectSource(fixture("wechat/wechat-legacy-sample.csv"), "wechat.csv")).toBe("wechat");
    expect(detectSource(fixture("wechat/wechat-sample.xlsx"), "wechat.xlsx")).toBe("wechat");
  });
});
