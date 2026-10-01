import { readFileSync } from "node:fs";
import { accounts, categories, type Db, transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { detectAndParse, type NormalizedRow, type ParseResult } from "@yomi/importers";
import { asc, eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { seed } from "../seed";
import { getCurrentUser } from "../user";
import type { AccountSpec } from "./accounts";
import { commitImport, commitParsed } from "./pipeline";

const user = getCurrentUser();
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../importers/test/fixtures/boa/${name}`, import.meta.url)));

async function freshDb(): Promise<Db> {
  const db = await testDb();
  await seed(db);
  return db;
}

const importFile = (db: Db, name: string) => commitImport(db, user, detectAndParse, fixture(name), name, { backup: false });

const PLAID_CHECKING: AccountSpec = {
  name: "Bank of America Adv Plus Banking 9876",
  kind: "debit_card",
  institution: "Bank of America",
  last4: "9876",
  currency: "USD",
};

let plaidSeq = 0;
function plaidRow(date: string, amountMinor: number, name: string): NormalizedRow {
  plaidSeq += 1;
  return {
    source: "plaid",
    lineNo: plaidSeq,
    externalId: `plaid_tx_${plaidSeq}`,
    occurredAt: `${date}T12:00:00-05:00`,
    amountMinor,
    currency: "USD",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: amountMinor < 0 ? "out" : "in",
    kind: amountMinor < 0 ? "expense" : "income",
    status: "ok",
    counterparty: name,
    description: name,
    sourceCategory: null,
    paymentMethod: "Bank of America Adv Plus Banking (9876)",
    raw: { synthetic: "1" },
  };
}

async function syncPlaid(db: Db, rows: NormalizedRow[], spec: AccountSpec = PLAID_CHECKING) {
  const parsed: ParseResult = { source: "plaid", rows, declared: {}, warnings: [] };
  return await commitParsed(db, user, parsed, {
    fileHash: `plaid-${plaidSeq}`,
    fileName: "plaid sync",
    backup: false,
    noDeclared: true,
    accountSpec: () => spec,
  });
}

const all = async (db: Db) => await db.select().from(transactions).orderBy(asc(transactions.id));
const catName = async (db: Db, id: number | null) => (id == null ? null : (await db.select().from(categories).where(eq(categories.id, id)).limit(1))[0]!.name);

describe("BoA CSV import", () => {
  it("creates the checking account, reconciles, cleans merchants and categorizes", async () => {
    const db = await freshDb();
    const r = await importFile(db, "boa-checking-sample.csv");
    expect(r).toMatchObject({ source: "boa_csv", rowsTotal: 9, inserted: 9, skippedDup: 0, linked: 0 });
    expect(r.reconciliation.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(await db.select().from(accounts)).toEqual([
      expect.objectContaining({ name: "Bank of America 支票", kind: "debit_card", institution: "Bank of America", last4: null, currency: "USD" }),
    ]);
    const byLine = await all(db);
    const view = [];
    for (const t of byLine) view.push([t.merchant, t.kind, await catName(db, t.categoryId)]);
    expect(view).toEqual([
      ["Sample Coffee House", "expense", "餐饮"],
      ["Sample Coffee House", "expense", "餐饮"],
      ["Alex Tester", "income", "转入"],
      ["Alex Tester", "expense", "人情"],
      ["Sample Payroll", "income", "工资"],
      ["Credit card", "transfer", null],
      ["Sample Sender", "income", "转入"],
      ["Wire Transfer Fee", "expense", "其他"],
      ["Sample Mart", "expense", "其他"],
    ]);
  });

  it("imports the card variant into its own credit card account", async () => {
    const db = await freshDb();
    const r = await importFile(db, "boa-card-sample.csv");
    expect(r).toMatchObject({ rowsTotal: 5, inserted: 5 });
    expect(await db.select().from(accounts)).toEqual([
      expect.objectContaining({ name: "Bank of America 信用卡", kind: "credit_card", institution: "Bank of America" }),
    ]);
    expect((await all(db)).map((t) => t.dedupKey.split(":").slice(0, 2).join(":"))).toEqual([
      "boa_csv:24000000000000000000001",
      "boa_csv:24000000000000000000002",
      "boa_csv:24000000000000000000003",
      "boa_csv:24000000000000000000004",
      "boa_csv:h",
    ]);
  });

  it("dedups two overlapping downloads by running balance, keeping identical same-day rows", async () => {
    const db = await freshDb();
    await importFile(db, "boa-checking-sample.csv");
    const second = await importFile(db, "boa-checking-overlap.csv");
    expect(second).toMatchObject({ rowsTotal: 7, inserted: 2, skippedDup: 5 });
    expect(second.reconciliation.ok).toBe(true);
    const rows = await all(db);
    expect(rows).toHaveLength(11);
    expect(rows.filter((t) => t.merchant === "Sample Coffee House")).toHaveLength(2);
    for (const t of rows) expect(t.dedupKey).toMatch(/^boa_csv:h:[0-9a-f]{64}$/);
  });
});

describe("BoA CSV ↔ Plaid cross-source link", () => {
  it("CSV first, then Plaid sync: Plaid rows point at the CSV rows", async () => {
    const db = await freshDb();
    await importFile(db, "boa-checking-sample.csv");
    const csvRows = await all(db);
    const payroll = csvRows.find((t) => t.merchant === "Sample Payroll")!;
    const fee = csvRows.find((t) => t.merchant === "Wire Transfer Fee")!;
    const r = await syncPlaid(db, [
      plaidRow("2026-09-06", 200000, "SAMPLE PAYROLL"),
      plaidRow("2026-09-07", -1600, "WIRE TRANSFER FEE"),
      plaidRow("2026-09-20", -1600, "WIRE TRANSFER FEE"),
    ]);
    expect(r).toMatchObject({ inserted: 3, linked: 2 });
    const plaid = (await all(db)).filter((t) => t.source === "plaid");
    expect(plaid.map((t) => t.duplicateOfId)).toEqual([payroll.id, fee.id, null]);
    expect((await all(db)).filter((t) => t.source === "boa_csv").every((t) => t.duplicateOfId == null)).toBe(true);
  });

  it("Plaid first, then CSV: CSV rows point at the Plaid rows; the two identical coffees claim one each", async () => {
    const db = await freshDb();
    await syncPlaid(db, [plaidRow("2026-09-01", -450, "SAMPLE COFFEE"), plaidRow("2026-09-02", -450, "SAMPLE COFFEE"), plaidRow("2026-09-03", 2500, "ZELLE")]);
    const plaidIds = (await all(db)).map((t) => t.id);
    const r = await importFile(db, "boa-checking-sample.csv");
    expect(r).toMatchObject({ inserted: 9, linked: 3 });
    const csv = (await all(db)).filter((t) => t.source === "boa_csv");
    expect(csv.filter((t) => t.duplicateOfId != null).map((t) => t.duplicateOfId).sort()).toEqual([...plaidIds].sort());
    expect((await all(db)).filter((t) => t.source === "plaid").every((t) => t.duplicateOfId == null)).toBe(true);
  });

  it("does not link across account kinds or other institutions", async () => {
    const db = await freshDb();
    await importFile(db, "boa-checking-sample.csv");
    const card = await syncPlaid(db, [plaidRow("2026-09-05", 200000, "X")], { ...PLAID_CHECKING, name: "BoA card", kind: "credit_card", last4: "4321" });
    const chase = await syncPlaid(db, [plaidRow("2026-09-05", 200000, "X")], { ...PLAID_CHECKING, name: "Chase", institution: "Chase", last4: "1111" });
    expect(card.linked).toBe(0);
    expect(chase.linked).toBe(0);
  });
});
