import { accounts, type Db, merchantRules, transactions, transactionSplits } from "@yomi/db";
import type { NormalizedRow, ParseResult } from "@yomi/importers";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { commitImport, previewImport, revertBatch } from "../import/pipeline";
import { listTransactions, unsplitSummary } from "../ledger";
import { addParticipant, addSplit, addTx, freshDb, selfId, user } from "../ledger/test-helpers";
import {
  applyAutoSplitToExisting,
  archiveParticipant,
  getSplit,
  listMerchantRules,
  setAutoSplit,
  setSplit,
  SplitError,
  toggleParticipant,
} from "./index";

async function withAccount(db: Db): Promise<number> {
  return (await db
    .insert(accounts)
    .values({ userId: user.id, name: "支付宝余额", kind: "wallet", institution: "支付宝", currency: "CNY" })
    .returning())[0]!.id;
}

async function ruleRow(db: Db, merchant: string) {
  return (await db.select().from(merchantRules).where(eq(merchantRules.merchant, merchant)).limit(1))[0];
}

describe("unsplit filter and summary", () => {
  it("lists only my own ok, unlinked, unsplit expenses and sums them per month and currency", async () => {
    const db = await freshDb();
    const acct = await withAccount(db);
    const rm = await addParticipant(db, "室友");
    const a = await addTx(db, { accountId: acct, amountMinor: -1000, merchant: "盒马", occurredAt: "2026-08-02T12:00:00+08:00" });
    const b = await addTx(db, { accountId: acct, amountMinor: -2550, currency: "USD", merchant: "Costco", occurredAt: "2026-08-20T12:00:00+08:00" });
    const c = await addTx(db, { accountId: acct, amountMinor: -300, merchant: "便利店", occurredAt: "2026-09-01T12:00:00+08:00" });
    const split = await addTx(db, { accountId: acct, amountMinor: -800, merchant: "盒马", occurredAt: "2026-09-02T12:00:00+08:00" });
    await toggleParticipant(db, user, split, rm); // also remembers 盒马 → 室友
    await addTx(db, { accountId: acct, amountMinor: -500, status: "closed", occurredAt: "2026-09-03T12:00:00+08:00" });
    await addTx(db, { accountId: acct, amountMinor: -500, kind: "transfer", occurredAt: "2026-09-03T12:00:00+08:00" });
    await addTx(db, { accountId: acct, amountMinor: 900, occurredAt: "2026-09-03T12:00:00+08:00" });
    await addTx(db, { accountId: acct, amountMinor: -500, duplicateOfId: c, occurredAt: "2026-09-03T12:00:00+08:00" });
    await addTx(db, { accountId: null, amountMinor: -700, occurredAt: "2026-09-04T12:00:00+08:00" });

    const all = await listTransactions(db, user, { unsplit: true });
    expect(all.items.map((t) => t.id).sort()).toEqual([a, b, c].sort());
    expect(all.total).toBe(3);
    expect((await listTransactions(db, user, { unsplit: true, month: "2026-08" })).items.map((t) => t.id).sort()).toEqual([a, b].sort());

    expect(await unsplitSummary(db, user)).toEqual([
      { month: "2026-09", count: 1, totals: [{ currency: "CNY", count: 1, amountMinor: 300 }], suggestedCount: 0 },
      {
        month: "2026-08",
        count: 2,
        totals: [
          { currency: "CNY", count: 1, amountMinor: 1000 },
          { currency: "USD", count: 1, amountMinor: 2550 },
        ],
        suggestedCount: 1,
      },
    ]);
  });
});

describe("merchant rules and auto-split", () => {
  it("setAutoSplit upserts participants and the flag, and listMerchantRules reports counts", async () => {
    const db = await freshDb();
    const acct = await withAccount(db);
    const rm = await addParticipant(db, "室友");
    const li = await addParticipant(db, "小李");
    await addTx(db, { accountId: acct, amountMinor: -1000, merchant: "Costco" });
    const done = await addTx(db, { accountId: acct, amountMinor: -1000, merchant: "Costco" });
    await addSplit(db, done, await selfId(db), 500);
    await addSplit(db, done, rm, 500);

    const on = await setAutoSplit(db, user, "Costco", { participantIds: [li, rm, await selfId(db)], enabled: true });
    expect(on).toMatchObject({ merchant: "Costco", autoSplit: true, rowCount: 2, unsplitCount: 1 });
    expect(on.participants.map((p) => p.id)).toEqual([rm, li]);
    expect(await ruleRow(db, "Costco")).toMatchObject({ participantIds: [rm, li], autoSplit: true });

    // Update in place (unique on user + merchant); disabling with no ids keeps the participants.
    await setAutoSplit(db, user, "Costco", { participantIds: [rm], enabled: true });
    await setAutoSplit(db, user, "Costco", { participantIds: [], enabled: false });
    expect(await db.select().from(merchantRules).where(eq(merchantRules.merchant, "Costco"))).toHaveLength(1);
    expect(await ruleRow(db, "Costco")).toMatchObject({ participantIds: [rm], autoSplit: false });
    expect(await listMerchantRules(db, user, { autoSplitOnly: true })).toEqual([]);
    expect((await listMerchantRules(db, user)).map((r) => r.merchant)).toEqual(["Costco"]);

    await expect(setAutoSplit(db, user, "Costco", { participantIds: [], enabled: true })).rejects.toThrow(SplitError);
    await expect(setAutoSplit(db, user, "Costco", { participantIds: [999], enabled: true })).rejects.toThrow(SplitError);
    await archiveParticipant(db, user, li, true);
    await expect(setAutoSplit(db, user, "Costco", { participantIds: [li], enabled: true })).rejects.toThrow(SplitError);
  });

  it("a one-off split does not rewrite an auto-split rule", async () => {
    const db = await freshDb();
    const acct = await withAccount(db);
    const rm = await addParticipant(db, "室友");
    const li = await addParticipant(db, "小李");
    await setAutoSplit(db, user, "Costco", { participantIds: [rm], enabled: true });
    const t = await addTx(db, { accountId: acct, amountMinor: -900, merchant: "Costco" });
    await setSplit(db, user, t, { participantIds: [li], mode: "equal" });
    expect(await ruleRow(db, "Costco")).toMatchObject({ participantIds: [rm], autoSplit: true });
  });

  it("applyAutoSplitToExisting splits unsplit rows equally, skips split rows, and marks them edited", async () => {
    const db = await freshDb();
    const acct = await withAccount(db);
    const me = await selfId(db);
    const rm = await addParticipant(db, "室友");
    const li = await addParticipant(db, "小李");
    const a = await addTx(db, { accountId: acct, amountMinor: -1001, merchant: "Costco" });
    const b = await addTx(db, { accountId: acct, amountMinor: -2000, merchant: "Costco", userEditedAt: "2026-09-01T00:00:00Z" });
    const already = await addTx(db, { accountId: acct, amountMinor: -3000, merchant: "Costco" });
    await setSplit(db, user, already, { participantIds: [li], mode: "full" });
    const other = await addTx(db, { accountId: acct, amountMinor: -500, merchant: "盒马" });

    await expect(applyAutoSplitToExisting(db, user, "Costco")).rejects.toThrow(SplitError); // no rule yet
    await setAutoSplit(db, user, "Costco", { participantIds: [rm], enabled: true });
    expect(await applyAutoSplitToExisting(db, user, "Costco")).toEqual({ merchant: "Costco", split: 2 });

    expect((await getSplit(db, user, a))!.rows.map((r) => [r.participantId, r.owedMinor, r.paidMinor])).toEqual([
      [me, 501, 1001],
      [rm, 500, 0],
    ]);
    expect((await getSplit(db, user, b))!.myShareMinor).toBe(1000);
    expect((await getSplit(db, user, already))!.mode).toBe("full");
    expect(await getSplit(db, user, other)).toBeNull();
    const edited = (await db.select().from(transactions).where(eq(transactions.id, a)).limit(1))[0]!;
    expect(edited.userEditedAt).not.toBeNull();
    expect(await applyAutoSplitToExisting(db, user, "Costco")).toEqual({ merchant: "Costco", split: 0 });
  });
});

let lineNo = 0;
function row(p: Partial<NormalizedRow> & Pick<NormalizedRow, "amountMinor" | "counterparty">): NormalizedRow {
  return {
    lineNo: ++lineNo,
    externalId: `ext-${lineNo}`,
    source: "alipay",
    occurredAt: "2026-09-05T12:00:00+08:00",
    currency: "CNY",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: p.amountMinor < 0 ? "out" : "in",
    kind: p.amountMinor < 0 ? "expense" : "income",
    status: "ok",
    description: "",
    sourceCategory: null,
    paymentMethod: "余额",
    raw: { note: "synthetic" },
    ...p,
  };
}

const parseOf = (rows: NormalizedRow[]) => async (): Promise<ParseResult> => ({ source: "alipay", rows, declared: {}, warnings: [] });
const bytes = (s: string) => new TextEncoder().encode(s);

describe("import auto-split", () => {
  it("splits new expense rows of auto-split merchants (remainder to me) and revert removes them with the rows", async () => {
    const db = await freshDb();
    const me = await selfId(db);
    const rm = await addParticipant(db, "室友");
    const li = await addParticipant(db, "小李");
    await setAutoSplit(db, user, "Costco", { participantIds: [rm, li], enabled: true });
    await setAutoSplit(db, user, "盒马", { participantIds: [rm], enabled: false });

    const rows = [
      row({ counterparty: "Costco", amountMinor: -1000 }),
      row({ counterparty: "Costco", amountMinor: 200, kind: "refund", direction: "in" }),
      row({ counterparty: "Costco", amountMinor: -400, status: "closed" }),
      row({ counterparty: "盒马", amountMinor: -600 }),
    ];
    const preview = await previewImport(db, user, parseOf(rows), bytes("a"), "a.csv");
    expect(preview.autoSplit).toBe(1);

    const res = await commitImport(db, user, parseOf(rows), bytes("a"), "a.csv");
    expect(res.autoSplit).toBe(1);
    const costco = (await listTransactions(db, user, { q: "Costco", kind: "expense" })).items.find((t) => t.status === "ok")!;
    expect(costco.splits.map((s) => [s.participantId, s.owedMinor, s.paidMinor])).toEqual([
      [me, 334, 1000],
      [rm, 333, 0],
      [li, 333, 0],
    ]);
    expect(costco.userEditedAt).toBeNull();
    expect(costco.myShareMinor).toBe(334);
    expect(await db.select().from(transactionSplits)).toHaveLength(3);
    // The rule itself is untouched by the import.
    expect(await ruleRow(db, "Costco")).toMatchObject({ participantIds: [rm, li].sort((x, y) => x - y), autoSplit: true });

    expect(await revertBatch(db, user, res.batchId)).toMatchObject({ deleted: 4, keptEdited: 0 });
    expect(await db.select().from(transactionSplits)).toHaveLength(0);
  });

  it("skips archived participants and rules left with nobody", async () => {
    const db = await freshDb();
    const rm = await addParticipant(db, "室友");
    await setAutoSplit(db, user, "Costco", { participantIds: [rm], enabled: true });
    await archiveParticipant(db, user, rm, true);
    const res = await commitImport(db, user, parseOf([row({ counterparty: "Costco", amountMinor: -1000 })]), bytes("b"), "b.csv");
    expect(res.autoSplit).toBe(0);
    expect(await db.select().from(transactionSplits)).toHaveLength(0);
  });
});
