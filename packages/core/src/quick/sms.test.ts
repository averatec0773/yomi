import { accounts, categories, type Db, transactions, transactionSplits } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import type { NormalizedRow, ParseResult } from "@yomi/importers";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { commitImport } from "../import/pipeline";
import { merchantsOverlap } from "../capture/match";
import { seed } from "../seed";
import { balances, createParticipant, setSplit } from "../split";
import { getCurrentUser } from "../user";
import { parseQuickEntry } from "./parse";
import { createSmsEntry, smsDedupKey } from "./sms";

const user = getCurrentUser();
const today = "2026-09-29";
const POS = "您尾号3141信用卡9月27日08:24POS支出(消费BUSY BEE BOBA Houston)15.74美元。【工商银行】";
const ONLINE = "您尾号3141信用卡9月27日08:38网上银行支出(消费)14.48美元。【工商银行】";

async function freshDb(): Promise<Db> {
  const db = await testDb();
  await seed(db);
  return db;
}

let line = 0;
function pdfRow(p: Partial<NormalizedRow> & Pick<NormalizedRow, "amountMinor">): NormalizedRow {
  return {
    source: "icbc_pdf",
    lineNo: ++line,
    externalId: null,
    occurredAt: "2026-09-28T00:00:00+08:00",
    currency: "USD",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: p.amountMinor < 0 ? "out" : "in",
    kind: p.amountMinor < 0 ? "expense" : "refund",
    status: "ok",
    counterparty: "BUSY BEE BOBA HOUSTON TX",
    description: "消费",
    sourceCategory: "消费",
    paymentMethod: "工商银行信用卡(3141)",
    raw: { note: "synthetic" },
    ...p,
  };
}

async function importPdf(db: Db, rows: NormalizedRow[], name = `icbc-${++line}.pdf`) {
  const parse = async (): Promise<ParseResult> => ({ source: "icbc_pdf", rows, declared: {}, warnings: [] });
  return commitImport(db, user, parse, new TextEncoder().encode(name), name, { backup: false });
}

const get = async (db: Db, id: number) => (await db.select().from(transactions).where(eq(transactions.id, id)).limit(1))[0]!;
const catName = async (db: Db, id: number | null) => (id == null ? null : (await db.select().from(categories).where(eq(categories.id, id)).limit(1))[0]?.name);

describe("createSmsEntry", () => {
  it("saves an alert on the ICBC card account with the raw text and an sms dedup key", async () => {
    const db = await freshDb();
    const r = await createSmsEntry(db, user, { text: POS, today });
    expect(r).toMatchObject({ alreadyAdded: false, duplicateOfId: null, myShareMinor: 1574 });
    const tx = await get(db, r.transactionId);
    expect(tx).toMatchObject({
      source: "sms",
      kind: "expense",
      amountMinor: -1574,
      currency: "USD",
      occurredAt: "2026-09-27T08:24:00+08:00",
      merchant: "Busy Bee Boba",
      counterpartyRaw: "BUSY BEE BOBA",
      descriptionRaw: "消费",
      sourceCategory: "消费",
      paymentMethod: "工商银行信用卡(3141)",
      dedupKey: expect.stringMatching(/^sms:[0-9a-f]{64}$/),
      userEditedAt: null,
    });
    expect(tx.raw).toMatchObject({ text: POS, city: "Houston", channel: "POS" });
    const acct = (await db.select().from(accounts).where(eq(accounts.id, tx.accountId!)).limit(1))[0];
    expect(acct).toMatchObject({ name: "工商银行信用卡 3141", kind: "credit_card", institution: "工商银行", last4: "3141", currency: "USD" });
  });

  it("does not duplicate the same alert pasted twice", async () => {
    const db = await freshDb();
    const a = await createSmsEntry(db, user, { text: POS, today });
    const b = await createSmsEntry(db, user, { text: `  ${POS}\n`, today });
    expect(b).toMatchObject({ transactionId: a.transactionId, alreadyAdded: true });
    expect(await db.select().from(transactions)).toHaveLength(1);
    expect(smsDedupKey({ last4: "3141", occurredAt: "x", amountMinor: -1, currency: "USD", merchant: "A" } as never)).toMatch(/^sms:/);
  });

  it("reuses the account the PDF importer created", async () => {
    const db = await freshDb();
    await importPdf(db, [pdfRow({ amountMinor: -999, counterparty: "OTHER SHOP", occurredAt: "2026-08-01T00:00:00+08:00" })]);
    const r = await createSmsEntry(db, user, { text: ONLINE, today });
    expect((await db.select().from(accounts)).filter((a) => a.last4 === "3141")).toHaveLength(1);
    expect((await get(db, r.transactionId)).merchant).toBe("");
  });

  it("splits with people typed after the alert", async () => {
    const db = await freshDb();
    const roommate = await createParticipant(db, user, "室友");
    const r = await createSmsEntry(db, user, { text: POS, today, participantIds: [roommate.id] });
    expect(r.split).not.toBeNull();
    expect(await balances(db, user)).toEqual([expect.objectContaining({ name: "室友", currency: "USD", owedToMeMinor: 787 })]);
  });

  it("rejects text that is not a supported alert", async () => {
    await expect(createSmsEntry(await freshDb(), user, { text: "lunch 35", today })).rejects.toThrow(/not a supported/);
  });
});

describe("SMS and the monthly PDF", () => {
  it("SMS first and split: the PDF row links to it and the SMS split and category survive", async () => {
    const db = await freshDb();
    const roommate = await createParticipant(db, user, "室友");
    const sms = await createSmsEntry(db, user, { text: POS, today });
    const dining = (await db.select().from(categories).where(eq(categories.name, "餐饮")).limit(1))[0]!;
    await setSplit(db, user, sms.transactionId, { participantIds: [roommate.id], mode: "equal" });
    await db.update(transactions).set({ categoryId: dining.id, note: "boba run" }).where(eq(transactions.id, sms.transactionId));

    const res = await importPdf(db, [pdfRow({ amountMinor: -1574 }), pdfRow({ amountMinor: -500, counterparty: "OTHER" })]);
    expect(res.captures.linked).toBe(1);
    const pdf = await db.select().from(transactions).where(eq(transactions.source, "icbc_pdf"));
    expect(pdf.find((t) => t.amountMinor === -1574)?.duplicateOfId).toBe(sms.transactionId);
    expect(pdf.find((t) => t.amountMinor === -500)?.duplicateOfId).toBeNull();
    const kept = await get(db, sms.transactionId);
    expect(kept).toMatchObject({ duplicateOfId: null, categoryId: dining.id, note: "boba run", merchant: "Busy Bee Boba" });
    expect(await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, sms.transactionId))).toHaveLength(2);
    expect(await balances(db, user)).toEqual([expect.objectContaining({ currency: "USD", owedToMeMinor: 787 })]);
  });

  it("SMS first without a merchant: the PDF row becomes the record and the SMS its duplicate", async () => {
    const db = await freshDb();
    const sms = await createSmsEntry(db, user, { text: ONLINE, today });
    expect(await catName(db, (await get(db, sms.transactionId)).categoryId)).toBe("其他");
    await importPdf(db, [pdfRow({ amountMinor: -1448, counterparty: "OPENAI *CHATGPT SUBSCR" })]);
    const pdf = (await db.select().from(transactions).where(eq(transactions.source, "icbc_pdf")).limit(1))[0]!;
    expect(pdf).toMatchObject({ merchant: "Openai", duplicateOfId: null });
    expect(await catName(db, pdf.categoryId)).toBe("订阅");
    expect((await get(db, sms.transactionId)).duplicateOfId).toBe(pdf.id);
  });

  it("does not link a different card, amount, date or merchant", async () => {
    const db = await freshDb();
    const sms = await createSmsEntry(db, user, { text: POS, today });
    await importPdf(db, [
      pdfRow({ amountMinor: -1574, paymentMethod: "工商银行信用卡(2222)" }),
      pdfRow({ amountMinor: -1575 }),
      pdfRow({ amountMinor: -1574, occurredAt: "2026-10-01T00:00:00+08:00" }),
      pdfRow({ amountMinor: -1574, counterparty: "SHELL OIL" }),
    ]);
    expect((await db.select().from(transactions)).filter((t) => t.duplicateOfId === sms.transactionId)).toEqual([]);
  });

  it("PDF first: the pasted SMS becomes the duplicate", async () => {
    const db = await freshDb();
    await importPdf(db, [pdfRow({ amountMinor: -1574, occurredAt: "2026-09-29T00:00:00+08:00" })]);
    const pdf = (await db.select().from(transactions).where(eq(transactions.source, "icbc_pdf")).limit(1))[0]!;
    const r = await createSmsEntry(db, user, { text: POS, today });
    expect(r).toMatchObject({ duplicateOfId: pdf.id, myShareMinor: 0 });
    expect((await get(db, r.transactionId)).duplicateOfId).toBe(pdf.id);
    expect((await get(db, pdf.id)).duplicateOfId).toBeNull();
    // A second PDF import of an overlapping file does not link to the duplicate SMS row.
    expect((await createSmsEntry(db, user, { text: POS, today })).alreadyAdded).toBe(true);
  });
});

describe("quick-add parse of an alert", () => {
  const ctx = { today, defaultCurrency: "CNY", participants: [{ id: 1, name: "我", isSelf: true }, { id: 2, name: "室友" }] };

  it("fills the draft from the alert and reads @people after it", () => {
    expect(parseQuickEntry(`${POS} @室友`, ctx)).toMatchObject({
      amountMinor: 1574,
      currency: "USD",
      description: "Busy Bee Boba",
      // 08:24 Beijing on the 27th is the evening of the 26th in Chicago (the default zone).
      date: "2026-09-26",
      participantIds: [2],
      payerId: null,
      errors: [],
      sms: {
        last4: "3141",
        occurredAt: "2026-09-27T08:24:00+08:00",
        occurredOn: "2026-09-26",
        merchant: "BUSY BEE BOBA",
        amountMinor: -1574,
        kind: "expense",
      },
    });
    expect(parseQuickEntry(POS, { ...ctx, timeZone: "Asia/Shanghai" })).toMatchObject({ date: "2026-09-27", sms: { occurredOn: "2026-09-27" } });
    expect(parseQuickEntry(ONLINE, ctx)).toMatchObject({ amountMinor: 1448, description: "", sms: { merchant: "" } });
  });

  it("reports an ICBC message it cannot read", () => {
    const d = parseQuickEntry("您尾号3141卡9月27日08:24快捷支付支出15.74元，余额100元。【工商银行】", ctx);
    expect(d.errors.map((e) => e.code)).toEqual(["quick_sms_unsupported"]);
    expect(d.amountMinor).toBeNull();
  });
});

describe("merchantsOverlap", () => {
  it("compares words, and Chinese names by containment", () => {
    expect(merchantsOverlap("Busy Bee Boba", "BUSY BEE BOBA HOUSTON TX")).toBe(true);
    expect(merchantsOverlap("Busy Bee Boba", "Shell Oil")).toBe(false);
    expect(merchantsOverlap("", "Shell")).toBe(true);
    expect(merchantsOverlap("美团", "美团外卖")).toBe(true);
  });
});
