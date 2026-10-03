import { captures, categories, type Db, transactions, transactionSplits } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import type { NormalizedRow, ParseResult, SourceId } from "@yomi/importers";
import { asc, eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { loadSourceActivity } from "../analysis/freshness";
import { commitImport, revertBatch } from "../import/pipeline";
import { rangeTotalsForList } from "../ledger/transactions";
import { createSmsEntry } from "../quick/sms";
import { seed } from "../seed";
import { createParticipant, setSplit } from "../split";
import { rangeOverview } from "../stats/range";
import { getCurrentUser } from "../user";
import { type AuthorityRow, evaluate, type OpenCapture, planMatches, runMatching } from "./match";
import { listReview, resolveReview, resolveReviewBulk, undoCapture } from "./review";

// Fictional card tails 3141 and 5501 only. Default time zone America/Chicago: an alert at 01:26 Beijing time on Oct 2
// is the afternoon of Oct 1 there.

const user = getCurrentUser();
const today = "2026-10-05";
const OCT = { from: "2026-10-01", to: "2026-10-31" };

const HOLD = "您尾号3141信用卡10月2日01:26网上银行支出(预授权额度冻结)23.50美元。【工商银行】";
const ONLINE = "您尾号3141信用卡10月2日01:26网上银行支出(消费)23.50美元。【工商银行】";
const POSTING = "您尾号3141信用卡10月3日09:10网上银行支出(消费)23.50美元。【工商银行】";
const COFFEE_1 = "您尾号3141信用卡10月1日21:05POS支出(消费CORNER CAFE Houston)5.00美元。【工商银行】";
const COFFEE_2 = "您尾号3141信用卡10月1日22:40POS支出(消费CORNER CAFE Houston)5.00美元。【工商银行】";
const REFUND = "您尾号3141信用卡10月4日10:02退货收入(退货CORNER CAFE Houston)5.00美元。【工商银行】";

async function freshDb(): Promise<Db> {
  const db = await testDb();
  await seed(db);
  return db;
}

let line = 0;
function row(source: SourceId, p: Partial<NormalizedRow> & Pick<NormalizedRow, "amountMinor" | "occurredAt">): NormalizedRow {
  return {
    source,
    lineNo: ++line,
    externalId: null,
    currency: "USD",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: p.amountMinor < 0 ? "out" : "in",
    kind: p.amountMinor < 0 ? "expense" : "refund",
    status: "ok",
    counterparty: "UBER *EATS HELP.UBER.COM CA",
    description: "消费",
    sourceCategory: "消费",
    paymentMethod: "工商银行信用卡(3141)",
    raw: { note: "synthetic" },
    ...p,
  };
}

async function importRows(db: Db, source: SourceId, rows: NormalizedRow[]) {
  const name = `${source}-${++line}`;
  const parse = async (): Promise<ParseResult> => ({ source, rows, declared: {}, warnings: [] });
  return commitImport(db, user, parse, new TextEncoder().encode(name), name, { backup: false });
}

const pdf = (db: Db, ...rows: Parameters<typeof row>[1][]) => importRows(db, "icbc_pdf", rows.map((r) => row("icbc_pdf", r)));
const paste = (db: Db, text: string) => createSmsEntry(db, user, { text, today });
const tx = async (db: Db, id: number) => (await db.select().from(transactions).where(eq(transactions.id, id)).limit(1))[0]!;
const cap = async (db: Db, id: number) => (await db.select().from(captures).where(eq(captures.id, id)).limit(1))[0]!;
const pdfRows = async (db: Db) => db.select().from(transactions).where(eq(transactions.source, "icbc_pdf")).orderBy(asc(transactions.id));
const usd = async (db: Db) => (await rangeTotalsForList(db, user, OCT.from, OCT.to)).find((t) => t.currency === "USD");

describe("capturing an SMS", () => {
  it("writes a provisional row in the user's zone and a capture; the same alert twice is one capture", async () => {
    const db = await freshDb();
    const a = await paste(db, ONLINE);
    expect(a).toMatchObject({ alreadyAdded: false, state: "provisional", review: null, duplicateOfId: null, myShareMinor: 2350 });
    expect(await tx(db, a.transactionId)).toMatchObject({ occurredAt: "2026-10-02T01:26:00+08:00", occurredOn: "2026-10-01", provisional: "capture" });
    expect(await cap(db, a.captureId)).toMatchObject({ kind: "sms", state: "provisional", last4: "3141", hold: false, amountMinor: -2350, payload: { text: ONLINE } });
    expect(await paste(db, ONLINE)).toMatchObject({ alreadyAdded: true, captureId: a.captureId, transactionId: a.transactionId });
    expect(await db.select().from(captures)).toHaveLength(1);
  });

  it("marks a hold, leaves its merchant empty and does not count it until it is replaced", async () => {
    const db = await freshDb();
    const h = await paste(db, HOLD);
    expect(h).toMatchObject({ state: "provisional", myShareMinor: 0 });
    expect(await tx(db, h.transactionId)).toMatchObject({ provisional: "hold", merchant: "", counterpartyRaw: "", descriptionRaw: "预授权额度冻结" });
    expect(await usd(db)).toBeUndefined();
    await paste(db, COFFEE_1);
    expect(await usd(db)).toMatchObject({ count: 1, spendingMinor: 500, provisional: { count: 1, minor: 500 }, holds: { count: 1, minor: 2350 } });
    const overview = (await rangeOverview(db, user, OCT, { today })).currencies.find((c) => c.currency === "USD")!;
    expect(overview).toMatchObject({ spendingMinor: 500, provisional: { count: 1, minor: 500 }, holds: { count: 1, minor: 2350 } });
    expect(overview.largest).toEqual([expect.objectContaining({ minor: 500, provisional: true })]);
  });

  it("a hold and the alert of the posted charge: the posting supersedes the hold", async () => {
    const db = await freshDb();
    const h = await paste(db, HOLD);
    const p = await paste(db, POSTING);
    expect(await cap(db, h.captureId)).toMatchObject({ state: "superseded", authorityId: p.transactionId });
    expect(await tx(db, h.transactionId)).toMatchObject({ duplicateOfId: p.transactionId, provisional: null });
    expect(await usd(db)).toMatchObject({ count: 1, spendingMinor: 2350, holds: { count: 0 } });
  });
});

describe("matching statement rows", () => {
  it("SMS first: an ICBC row posted the next day (Beijing time) supersedes it and keeps the statement's facts", async () => {
    const db = await freshDb();
    const s = await paste(db, ONLINE);
    const dining = (await db.select().from(categories).where(eq(categories.name, "餐饮")).limit(1))[0]!;
    await db.update(transactions).set({ categoryId: dining.id, note: "lunch with the team" }).where(eq(transactions.id, s.transactionId));
    const res = await pdf(db, { amountMinor: -2350, occurredAt: "2026-10-03T09:00:00+08:00", counterparty: "QUIET LANE SHOP" });
    expect(res.captures).toEqual({ linked: 1, toReview: 0 });
    const [p] = await pdfRows(db);
    expect(p).toMatchObject({ occurredOn: "2026-10-02", duplicateOfId: null, categoryId: dining.id, note: "lunch with the team" });
    expect(await tx(db, s.transactionId)).toMatchObject({ duplicateOfId: p!.id, provisional: null });
    expect(await cap(db, s.captureId)).toMatchObject({
      state: "superseded",
      authorityId: p!.id,
      payload: { history: [expect.objectContaining({ to: "provisional" }), expect.objectContaining({ from: "provisional", to: "superseded", by: `import:${res.batchId}` })] },
    });
    expect((await cap(db, s.captureId)).payload.text).toBeUndefined();
    expect(await usd(db)).toMatchObject({ count: 1, spendingMinor: 2350, provisional: { count: 0 } });
  });

  it("SMS after its statement row: superseded at once", async () => {
    const db = await freshDb();
    await pdf(db, { amountMinor: -2350, occurredAt: "2026-10-03T09:00:00+08:00" });
    const s = await paste(db, ONLINE);
    const [p] = await pdfRows(db);
    expect(s).toMatchObject({ state: "superseded", duplicateOfId: p!.id, myShareMinor: 0 });
  });

  it("a row 5 days later is a near miss and nothing is linked; 7 days later is no candidate", async () => {
    const db = await freshDb();
    const s = await paste(db, ONLINE);
    await pdf(db, { amountMinor: -2350, occurredAt: "2026-10-09T09:00:00+08:00" });
    expect(await cap(db, s.captureId)).toMatchObject({ state: "provisional", review: null });
    await pdf(db, { amountMinor: -2350, occurredAt: "2026-10-07T09:00:00+08:00", counterparty: "UBER *EATS PENDING" });
    const c = await cap(db, s.captureId);
    expect(c).toMatchObject({ state: "provisional", review: "near_miss" });
    expect(c.payload.candidates).toEqual([{ id: (await pdfRows(db))[1]!.id, reasons: ["amount", "card"] }]);
    expect((await tx(db, s.transactionId)).duplicateOfId).toBeNull();
  });

  it("a hold and a statement row 15% higher (a tip) is a near miss; Same charge takes the statement amount", async () => {
    const db = await freshDb();
    const h = await paste(db, HOLD);
    await pdf(db, { amountMinor: -2710, occurredAt: "2026-10-03T09:00:00+08:00" });
    const [p] = await pdfRows(db);
    const review = await listReview(db, user, { today });
    expect(review.items).toEqual([
      expect.objectContaining({
        captureId: h.captureId,
        type: "near_miss",
        capture: expect.objectContaining({ hold: true, amountMinor: -2350, occurredOn: "2026-10-01" }),
        candidates: [expect.objectContaining({ transactionId: p!.id, reasons: ["card", "time"], daysAfter: 1, amountDiffMinor: 360 })],
      }),
    ]);
    expect(await usd(db)).toMatchObject({ spendingMinor: 2710, holds: { count: 1, minor: 2350 } });
    await resolveReview(db, user, h.captureId, { action: "link", candidateId: p!.id });
    expect(await usd(db)).toMatchObject({ count: 1, spendingMinor: 2710, holds: { count: 0 } });
    expect((await listReview(db, user, { today })).total).toBe(0);
  });

  it("one statement row and two identical alerts: ambiguous for both, nothing linked, Choose links one", async () => {
    const db = await freshDb();
    const a = await paste(db, COFFEE_1);
    const b = await paste(db, COFFEE_2);
    const res = await pdf(db, { amountMinor: -500, occurredAt: "2026-10-02T08:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX" });
    expect(res.captures).toEqual({ linked: 0, toReview: 2 });
    expect((await cap(db, a.captureId)).review).toBe("ambiguous");
    expect((await cap(db, b.captureId)).review).toBe("ambiguous");
    expect(await usd(db)).toMatchObject({ count: 3, spendingMinor: 1500, provisional: { count: 2, minor: 1000 } });
    const [p] = await pdfRows(db);
    await resolveReview(db, user, b.captureId, { action: "link", candidateId: p!.id });
    expect(await cap(db, b.captureId)).toMatchObject({ state: "superseded", authorityId: p!.id });
    // The other alert loses its only candidate and leaves the queue.
    expect(await cap(db, a.captureId)).toMatchObject({ state: "provisional", review: null });
    expect(await usd(db)).toMatchObject({ count: 2, spendingMinor: 1000 });
  });

  it("two alerts and two rows of the same charge pair in time order; with a split on one they go to review", async () => {
    const db = await freshDb();
    const a = await paste(db, COFFEE_1);
    const b = await paste(db, COFFEE_2);
    await pdf(
      db,
      { amountMinor: -500, occurredAt: "2026-10-02T09:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX" },
      { amountMinor: -500, occurredAt: "2026-10-02T11:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX" },
    );
    const [p1, p2] = await pdfRows(db);
    expect((await cap(db, a.captureId)).authorityId).toBe(p1!.id);
    expect((await cap(db, b.captureId)).authorityId).toBe(p2!.id);

    const db2 = await freshDb();
    const roommate = await createParticipant(db2, user, "室友");
    const c = await createSmsEntry(db2, user, { text: COFFEE_1, today, participantIds: [roommate.id] });
    const d = await paste(db2, COFFEE_2);
    await pdf(
      db2,
      { amountMinor: -500, occurredAt: "2026-10-02T09:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX" },
      { amountMinor: -500, occurredAt: "2026-10-02T11:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX" },
    );
    expect((await cap(db2, c.captureId)).review).toBe("ambiguous");
    expect((await cap(db2, d.captureId)).review).toBe("ambiguous");
  });

  it("never pairs another card, and a refund alert matches the statement's refund row", async () => {
    const db = await freshDb();
    const s = await paste(db, COFFEE_1);
    const r = await paste(db, REFUND);
    await pdf(db, { amountMinor: -500, occurredAt: "2026-10-02T08:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX", paymentMethod: "工商银行信用卡(5501)" });
    expect(await cap(db, s.captureId)).toMatchObject({ state: "provisional", review: null });
    await pdf(db, { amountMinor: 500, occurredAt: "2026-10-05T08:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX", kind: "refund", description: "退货" });
    expect(await cap(db, r.captureId)).toMatchObject({ state: "superseded" });
  });

  it("an Alipay row paid with the card within ten minutes supersedes the alert; a split alert stays the record", async () => {
    const db = await freshDb();
    const wallet = (occurredAt: string) =>
      row("alipay", { amountMinor: -2350, occurredAt, currency: "USD", counterparty: "优步外卖", paymentMethod: "工商银行信用卡(3141)" });
    const s = await paste(db, ONLINE);
    await importRows(db, "alipay", [wallet("2026-10-02T01:31:00+08:00")]);
    expect(await cap(db, s.captureId)).toMatchObject({ state: "superseded" });

    const db2 = await freshDb();
    const roommate = await createParticipant(db2, user, "室友");
    const t = await createSmsEntry(db2, user, { text: ONLINE, today, participantIds: [roommate.id] });
    await importRows(db2, "alipay", [wallet("2026-10-02T01:20:00+08:00")]);
    expect(await cap(db2, t.captureId)).toMatchObject({ state: "confirmed" });
    const alipay = (await db2.select().from(transactions).where(eq(transactions.source, "alipay")))[0]!;
    expect(alipay.duplicateOfId).toBe(t.transactionId);
    expect(await usd(db2)).toMatchObject({ count: 1, spendingMinor: 1175 });
  });

  it("a split hold confirmed by a higher statement row takes its amount; equal splits follow, exact ones go to review; revert restores", async () => {
    const db = await freshDb();
    const roommate = await createParticipant(db, user, "室友");
    const h = await createSmsEntry(db, user, { text: HOLD, today, participantIds: [roommate.id] });
    const res = await pdf(db, { amountMinor: -2710, occurredAt: "2026-10-03T09:00:00+08:00" });
    const [p] = await pdfRows(db);
    await resolveReview(db, user, h.captureId, { action: "link", candidateId: p!.id });
    expect(await cap(db, h.captureId)).toMatchObject({ state: "confirmed", review: null, authorityId: p!.id });
    expect(await tx(db, h.transactionId)).toMatchObject({ amountMinor: -2710, occurredOn: "2026-10-02", provisional: null, duplicateOfId: null });
    expect((await tx(db, p!.id)).duplicateOfId).toBe(h.transactionId);
    const owed = async () => (await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, h.transactionId))).map((s) => s.owedMinor).sort();
    expect(await owed()).toEqual([1355, 1355]);
    expect(await usd(db)).toMatchObject({ count: 1, spendingMinor: 1355 });

    await revertBatch(db, user, res.batchId, { backup: false });
    expect(await cap(db, h.captureId)).toMatchObject({ state: "provisional", authorityId: null });
    expect(await tx(db, h.transactionId)).toMatchObject({ amountMinor: -2350, provisional: "hold", duplicateOfId: null });
    expect(await owed()).toEqual([1175, 1175]);

    const db2 = await freshDb();
    const other = await createParticipant(db2, user, "室友");
    const e = await paste(db2, HOLD);
    await setSplit(db2, user, e.transactionId, { participantIds: [other.id], mode: "exact", exact: [{ participantId: other.id, owedMinor: 1000 }] });
    await pdf(db2, { amountMinor: -2710, occurredAt: "2026-10-03T09:00:00+08:00" });
    const [q] = await pdfRows(db2);
    await resolveReview(db2, user, e.captureId, { action: "link", candidateId: q!.id });
    const review = await listReview(db2, user, { today });
    expect(review.items).toEqual([expect.objectContaining({ captureId: e.captureId, type: "amount_changed", shares: { sharesMinor: 2350, amountMinor: 2710 } })]);
    await resolveReview(db2, user, e.captureId, { action: "keep_shares" });
    expect((await listReview(db2, user, { today })).total).toBe(0);
  });
});

describe("the review queue", () => {
  it("an alert goes stale when the card's statement covers its day without a match, or after 14 days", async () => {
    const db = await freshDb();
    const s = await paste(db, COFFEE_1);
    expect((await listReview(db, user, { today })).total).toBe(0);
    expect((await listReview(db, user, { today: "2026-10-15" })).items).toEqual([
      expect.objectContaining({ captureId: s.captureId, type: "stale", stale: { reason: "age", days: 14 } }),
    ]);
    // A statement of another card says nothing about this one; the card's own statement through Oct 4 does.
    await pdf(db, { amountMinor: -999, occurredAt: "2026-10-06T09:00:00+08:00", counterparty: "OTHER SHOP", paymentMethod: "工商银行信用卡(5501)" });
    expect((await listReview(db, user, { today })).total).toBe(0);
    await pdf(db, { amountMinor: -999, occurredAt: "2026-09-20T09:00:00+08:00", counterparty: "OTHER SHOP" }, { amountMinor: -888, occurredAt: "2026-10-05T09:00:00+08:00", counterparty: "OTHER SHOP" });
    expect((await listReview(db, user, { today })).items).toEqual([
      expect.objectContaining({ type: "stale", stale: { reason: "covered", source: "icbc_pdf", through: "2026-10-04" } }),
    ]);
  });

  it("Keep as final, Discard and Keep separate, each undoable; kept-separate rows are not offered again", async () => {
    const db = await freshDb();
    const s = await paste(db, COFFEE_1);
    await resolveReview(db, user, s.captureId, { action: "keep_final" });
    expect(await tx(db, s.transactionId)).toMatchObject({ provisional: null, status: "ok" });
    expect(await usd(db)).toMatchObject({ count: 1, provisional: { count: 0 } });
    await undoCapture(db, user, s.captureId);
    expect(await cap(db, s.captureId)).toMatchObject({ state: "provisional", resolvedAt: null });
    expect((await cap(db, s.captureId)).payload.text).toBe(COFFEE_1);

    const h = await paste(db, HOLD);
    await resolveReview(db, user, h.captureId, { action: "discard" });
    expect(await tx(db, h.transactionId)).toMatchObject({ status: "closed", provisional: null });
    await undoCapture(db, user, h.captureId);
    expect(await tx(db, h.transactionId)).toMatchObject({ status: "ok", provisional: "hold" });

    await pdf(
      db,
      { amountMinor: -500, occurredAt: "2026-10-02T09:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX" },
      { amountMinor: -500, occurredAt: "2026-10-02T10:00:00+08:00", counterparty: "CORNER CAFE HOUSTON TX" },
    );
    expect(await cap(db, s.captureId)).toMatchObject({ review: "ambiguous" });
    await resolveReview(db, user, s.captureId, { action: "keep_separate" });
    await runMatching(db, user, { by: "user" });
    expect(await cap(db, s.captureId)).toMatchObject({ state: "provisional", review: null });
    expect((await cap(db, s.captureId)).payload.rejected).toHaveLength(2);
    await undoCapture(db, user, s.captureId);
    expect(await cap(db, s.captureId)).toMatchObject({ review: "ambiguous", payload: expect.objectContaining({ rejected: [] }) });
  });

  it("bulk actions run in one transaction and refuse actions that do not apply", async () => {
    const db = await freshDb();
    const a = await paste(db, COFFEE_1);
    const b = await paste(db, ONLINE);
    expect(await resolveReviewBulk(db, user, { captureIds: [a.captureId, b.captureId], action: "discard" })).toEqual({
      captureIds: [a.captureId, b.captureId],
      states: ["discarded", "discarded"],
    });
    await expect(resolveReviewBulk(db, user, { captureIds: [a.captureId], action: "keep_final" })).rejects.toMatchObject({ code: "capture_action_invalid" });
    await expect(resolveReview(db, user, a.captureId, { action: "link", candidateId: 1 })).rejects.toMatchObject({ code: "capture_action_invalid" });
  });

  it("a start-up run offers an old pair for review but never links it", async () => {
    const db = await freshDb();
    const s = await paste(db, ONLINE);
    // A statement row already in the ledger that no import run compared with the alert (as after the upgrade).
    await db.insert(transactions).values({
      userId: 1,
      occurredAt: "2026-10-03T09:00:00+08:00",
      occurredOn: "2026-10-02",
      amountMinor: -2350,
      currency: "USD",
      kind: "expense",
      source: "icbc_pdf",
      paymentMethod: "工商银行信用卡(3141)",
      dedupKey: "old-pdf-row",
    });
    expect(await runMatching(db, user, { by: "startup" })).toEqual({ linked: 0, toReview: 1 });
    expect(await runMatching(db, user, { by: "startup" })).toEqual({ linked: 0, toReview: 1 });
    expect(await cap(db, s.captureId)).toMatchObject({ state: "provisional", review: "ambiguous" });
  });
});

describe("analysis", () => {
  it("a provisional alert makes the ICBC statement count as in use for its currency", async () => {
    const db = await freshDb();
    await paste(db, COFFEE_1);
    expect(await loadSourceActivity(db, user, OCT)).toEqual([{ key: "icbc_pdf", currency: "USD" }]);
  });
});

describe("planMatches", () => {
  const capture = (id: number, p: Partial<OpenCapture> = {}): OpenCapture => ({
    id,
    transactionId: 100 + id,
    occurredAt: "2026-10-02T01:26:00+08:00",
    occurredOn: "2026-10-01",
    amountMinor: -500,
    currency: "USD",
    last4: "3141",
    hold: false,
    merchant: "Corner Cafe",
    locked: false,
    rejected: [],
    isNew: false,
    ...p,
  });
  const authority = (id: number, p: Partial<AuthorityRow> = {}): AuthorityRow => ({
    id,
    source: "icbc_pdf",
    occurredAt: "2026-10-03T09:00:00+08:00",
    occurredOn: "2026-10-02",
    amountMinor: -500,
    currency: "USD",
    originalAmountMinor: null,
    originalCurrency: null,
    merchant: "Corner Cafe",
    last4: "3141",
    isNew: true,
    ...p,
  });

  it("links one-to-one only, with something new on a side", () => {
    expect(planMatches([capture(1)], [authority(10)]).link).toEqual([{ captureId: 1, authorityId: 10 }]);
    expect(planMatches([capture(1)], [authority(10, { isNew: false })]).reviews.get(1)?.review).toBe("ambiguous");
    const tie = planMatches([capture(1)], [authority(10), authority(11, { occurredOn: "2026-10-03" })]);
    expect(tie.link).toEqual([]);
    expect(tie.reviews.get(1)?.candidates.map((c) => c.authorityId)).toEqual([10, 11]);
  });

  it("matches a foreign charge on its original amount and keeps 3141 away from 5501", () => {
    const fx = authority(10, { amountMinor: -3900, currency: "HKD", originalAmountMinor: -500, originalCurrency: "USD" });
    expect(evaluate(capture(1), fx)).toMatchObject({ near: false, reasons: ["amount", "card", "merchant", "time"] });
    expect(evaluate(capture(1), authority(11, { last4: "5501" }))).toBeNull();
    expect(evaluate(capture(1, { hold: true }), authority(12, { amountMinor: -651 }))).toBeNull();
    expect(evaluate(capture(1, { hold: true }), authority(12, { amountMinor: -650 }))).toMatchObject({ near: true });
  });
});
