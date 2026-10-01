import { transactions } from "@yomi/db";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { addParticipant, addSplit, addTx, catId, freshDb, selfId, user } from "../ledger/test-helpers";
import { formatMinorDecimal } from "../money";
import { recordSettlement } from "../split/settlements";
import { exportSplitCsv, exportTransactionsCsv, toCsv } from "./csv";

/** Minimal RFC 4180 reader for assertions (handles quotes, doubled quotes and embedded newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      i++;
    } else cur += ch;
  }
  return rows;
}

describe("formatMinorDecimal", () => {
  it("formats integer minor units as plain decimals", () => {
    expect(formatMinorDecimal(-123456, "CNY")).toBe("-1234.56");
    expect(formatMinorDecimal(5, "USD")).toBe("0.05");
    expect(formatMinorDecimal(-7, "CNY")).toBe("-0.07");
    expect(formatMinorDecimal(0, "CNY")).toBe("0.00");
    expect(formatMinorDecimal(1200, "JPY")).toBe("1200");
    expect(formatMinorDecimal(900719925474099, "CNY")).toBe("9007199254740.99");
  });
});

describe("toCsv", () => {
  it("adds a BOM, uses CRLF and quotes commas, quotes and newlines", () => {
    const out = toCsv([
      ["a", "b"],
      ['x,y', 'say "hi"', "two\nlines", "plain"],
    ]);
    expect(out.startsWith("﻿a,b\r\n")).toBe(true);
    expect(out).toContain('"x,y","say ""hi""","two\nlines",plain\r\n');
  });
});

describe("exportTransactionsCsv", () => {
  async function setup() {
    const db = await freshDb();
    const roomie = await addParticipant(db, "室友");
    const food = await catId(db, "餐饮");
    const a = await addTx(db, {
      amountMinor: -3500,
      merchant: "面馆, 二楼",
      descriptionRaw: '牛肉面 "大碗"',
      note: "第一行\n第二行",
      categoryId: food,
      occurredAt: "2026-09-03T12:05:09+08:00",
    });
    await addSplit(db, a, await selfId(db), 1750, 3500);
    await addSplit(db, a, roomie, 1750, 0);
    const b = await addTx(db, { amountMinor: -1234, merchant: "Uber", currency: "USD", source: "manual", occurredAt: "2026-09-05T09:00:00+08:00" });
    await addSplit(db, b, await selfId(db), 617, 0, "USD");
    await addSplit(db, b, roomie, 617, 1234, "USD");
    await addTx(db, { amountMinor: 500000, merchant: "公司", kind: "income", occurredAt: "2026-09-10T09:00:00+08:00" });
    await addTx(db, { amountMinor: -3500, merchant: "关联的银行行", occurredAt: "2026-09-03T12:05:09+08:00", duplicateOfId: a });
    await addTx(db, { amountMinor: -999, merchant: "八月", occurredAt: "2026-08-30T09:00:00+08:00" });
    return db;
  }

  it("writes one row per visible transaction, oldest first, with shares and payer", async () => {
    const db = await setup();
    const csv = await exportTransactionsCsv(db, user, { month: "2026-09", locale: "zh-CN" });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(csv.slice(1));
    expect(rows[0]).toEqual(["日期", "时间", "商户", "说明", "分类", "类型", "金额", "币种", "我承担", "分摊", "付款人", "账户", "来源", "备注"]);
    expect(rows.slice(1)).toEqual([
      ["2026-09-03", "12:05:09", "面馆, 二楼", '牛肉面 "大碗"', "餐饮", "支出", "-35.00", "CNY", "17.50", "室友 17.50; 我 17.50", "我", "", "支付宝", "第一行\n第二行"],
      ["2026-09-05", "09:00:00", "Uber", "", "", "支出", "-12.34", "USD", "6.17", "室友 6.17; 我 6.17", "室友", "", "手动", ""],
      ["2026-09-10", "09:00:00", "公司", "", "", "收入", "5000.00", "CNY", "", "", "", "", "支付宝", ""],
    ]);
    const en = parseCsv((await exportTransactionsCsv(db, user, { month: "2026-09" })).slice(1));
    expect(en[0]).toEqual(["Date", "Time", "Merchant", "Description", "Category", "Type", "Amount", "Currency", "My share", "Split", "Payer", "Account", "Source", "Note"]);
    expect(en[1]!.slice(5, 13)).toEqual(["Expense", "-35.00", "CNY", "17.50", "室友 17.50; Me 17.50", "Me", "", "Alipay"]);
  });

  it("exports every month without a filter and rejects a bad month", async () => {
    const db = await setup();
    const rows = parseCsv((await exportTransactionsCsv(db, user)).slice(1));
    expect(rows.slice(1).map((r) => r[2])).toEqual(["八月", "面馆, 二楼", "Uber", "公司"]);
    expect(rows[1]![8]).toBe("9.99");
    await expect(exportTransactionsCsv(db, user, { month: "2026-13" })).rejects.toThrow();
  });
});

describe("exportSplitCsv", () => {
  it("lists shared expenses and settlements then the balance", async () => {
    const db = await freshDb();
    const roomie = await addParticipant(db, "室友");
    const a = await addTx(db, { amountMinor: -3500, merchant: "面馆", occurredAt: "2026-09-03T12:00:00+08:00" });
    await addSplit(db, a, await selfId(db), 1750, 3500);
    await addSplit(db, a, roomie, 1750, 0);
    const b = await addTx(db, { amountMinor: -8000, merchant: "电费", occurredAt: "2026-09-06T12:00:00+08:00" });
    await addSplit(db, b, await selfId(db), 4000, 0);
    await addSplit(db, b, roomie, 4000, 8000);
    await recordSettlement(db, user, { participantId: roomie, amountMinor: 1000, currency: "CNY", settledOn: "2026-09-08", note: "先还一点" });

    const rows = parseCsv((await exportSplitCsv(db, user, roomie, "CNY", { locale: "zh-CN" })).slice(1));
    expect(parseCsv((await exportSplitCsv(db, user, roomie, "CNY")).slice(1)).at(-1)).toEqual(["", "Total", "", "", "", "", "-32.50", "I owe 室友", ""]);
    expect(rows).toEqual([
      ["日期", "类型", "商户", "总额", "对方份额", "付款人", "变动", "备注", "分摊"],
      ["2026-09-03", "共同支出", "面馆", "35.00", "17.50", "我", "17.50", "", ""],
      ["2026-09-06", "共同支出", "电费", "80.00", "40.00", "室友", "-40.00", "", ""],
      ["2026-09-08", "结算（对方转我）", "", "10.00", "", "室友", "-10.00", "先还一点", ""],
      ["", "合计", "", "", "", "", "-32.50", "我欠室友", ""],
    ]);
  });

  it("applies the statement options: names, my share, notes, settlements", async () => {
    const db = await freshDb();
    const roomie = await addParticipant(db, "室友");
    const li = await addParticipant(db, "Li");
    const a = await addTx(db, { amountMinor: -3000, merchant: "Market", occurredAt: "2026-09-03T12:00:00+08:00" });
    await addSplit(db, a, await selfId(db), 1000, 3000);
    await addSplit(db, a, roomie, 1000, 0);
    await addSplit(db, a, li, 1000, 0);
    await db.update(transactions).set({ sharedNote: "eggs too" }).where(eq(transactions.id, a));
    await recordSettlement(db, user, { participantId: roomie, amountMinor: 500, currency: "CNY", settledOn: "2026-09-08" });

    const byDefault = parseCsv((await exportSplitCsv(db, user, roomie, "CNY")).slice(1));
    expect(byDefault[1]).toEqual(["2026-09-03", "Shared expense", "Market", "30.00", "10.00", "Me", "10.00", "eggs too", "Split 3 ways"]);
    expect(byDefault).toHaveLength(4);

    const rows = parseCsv((await exportSplitCsv(db, user, roomie, "CNY", { locale: "zh-CN", show: ["names", "myshare"] })).slice(1));
    expect(rows).toEqual([
      ["日期", "类型", "商户", "总额", "对方份额", "付款人", "变动", "备注", "分摊", "我的份额"],
      ["2026-09-03", "共同支出", "Market", "30.00", "10.00", "我", "10.00", "", "3 人分摊（和 Li）", "10.00"],
      ["", "合计", "", "", "", "", "5.00", "室友欠我", "", ""],
    ]);
  });
});
