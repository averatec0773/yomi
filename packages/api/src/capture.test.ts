import {
  ApiError,
  BulkTransactionReviewResult,
  type CaptureReviewItem,
  Identity,
  ImportResult,
  Participant,
  ParticipantList,
  QuickCreated,
  ResolveResult,
  ReviewList,
  TransactionPage,
  TransactionReviewResult,
} from "@yomi/contracts";
import { seed } from "@yomi/core";
import { accounts, transactions } from "@yomi/db";
import type { NormalizedRow } from "@yomi/importers";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

// Fictional card 3141 only.
const COFFEE_1 = "您尾号3141信用卡10月1日21:05POS支出(消费CORNER CAFE Houston)5.00美元。【工商银行】";
const COFFEE_2 = "您尾号3141信用卡10月1日22:40POS支出(消费CORNER CAFE Houston)5.00美元。【工商银行】";

function pdfRow(lineNo: number): NormalizedRow {
  return {
    source: "icbc_pdf",
    lineNo,
    externalId: null,
    occurredAt: "2026-10-02T09:00:00+08:00",
    amountMinor: -500,
    currency: "USD",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: "out",
    kind: "expense",
    status: "ok",
    counterparty: "CORNER CAFE HOUSTON TX",
    description: "消费",
    sourceCategory: "消费",
    paymentMethod: "工商银行信用卡(3141)",
    raw: { note: "synthetic" },
  };
}

async function setup() {
  const db = await testDb();
  await seed(db);
  const app = createApi({
    getDb: () => db,
    parse: async () => ({ source: "icbc_pdf", rows: [pdfRow(1)], declared: {}, warnings: [] }),
    today: () => "2026-10-05",
  });
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const draft = { amountMinor: 500, currency: "USD", description: "", date: "2026-10-01", participantIds: [], payerId: null, mode: "equal", categoryHint: null, errors: [] };
  const paste = async (text: string) => QuickCreated.parse(await (await app.request("/api/quick", json({ ...draft, smsText: text, today: "2026-10-05" }))).json());
  const review = async () => ReviewList.parse(await (await app.request("/api/review")).json());
  return { app, json, paste, review };
}

describe("capture review api", () => {
  it("lists the queue, links a candidate, undoes it, and reports the import's pointer", async () => {
    const { app, json, paste, review } = await setup();
    const a = await paste(COFFEE_1);
    const b = await paste(COFFEE_2);
    expect(a).toMatchObject({ state: "provisional", review: null });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "icbc.pdf"));
    const imported = ImportResult.parse(await (await app.request("/api/import/commit", { method: "POST", body: form })).json());
    expect(imported.captures).toEqual({ linked: 0, toReview: 2 });

    const queue = await review();
    expect(queue.counts).toEqual({ ambiguous: 2, near_miss: 0, stale: 0, amount_changed: 0, repayment: 0, own_transfer: 0 });
    const item = queue.items.find((i) => i.subject === "capture" && i.captureId === a.captureId) as CaptureReviewItem;
    expect(item).toMatchObject({ type: "ambiguous", capture: { last4: "3141", amountMinor: -500, hold: false }, candidates: [{ reasons: ["amount", "card", "merchant", "time"], daysAfter: 0 }] });

    const linked = await app.request(`/api/review/${a.captureId}`, json({ action: "link", candidateId: item.candidates[0]!.transactionId }));
    expect(ResolveResult.parse(await linked.json())).toEqual({ captureIds: [a.captureId], states: ["superseded"] });
    expect((await review()).total).toBe(0);
    const page = TransactionPage.parse(await (await app.request("/api/transactions?month=2026-10")).json());
    expect(page.items.find((t) => t.id === a.transactionId)).toMatchObject({ provisional: null, capture: { state: "superseded", authoritySource: "icbc_pdf", canUndo: true } });
    expect(page.items.find((t) => t.id === b.transactionId)).toMatchObject({ provisional: "capture", capture: { state: "provisional", canUndo: false } });

    const undone = await app.request(`/api/captures/${a.captureId}/undo`, { method: "POST" });
    expect(ResolveResult.parse(await undone.json()).states).toEqual(["provisional"]);
    expect((await review()).counts.ambiguous).toBe(2);

    const bulk = await app.request("/api/review/bulk", json({ captureIds: [a.captureId, b.captureId], action: "keep_separate" }));
    expect(ResolveResult.parse(await bulk.json()).states).toEqual(["provisional", "provisional"]);
    expect((await review()).total).toBe(0);
  });

  it("refuses bad bodies, unknown captures and actions that do not apply", async () => {
    const { app, json, paste } = await setup();
    const a = await paste(COFFEE_1);
    const code = async (res: Response) => ApiError.parse(await res.json()).code;
    const noCandidate = await app.request(`/api/review/${a.captureId}`, json({ action: "link" }));
    expect(noCandidate.status).toBe(400);
    expect(await code(noCandidate)).toBe("validation_failed");
    const bulkLink = await app.request("/api/review/bulk", json({ captureIds: [a.captureId], action: "link" }));
    expect(bulkLink.status).toBe(400);
    const missing = await app.request("/api/review/999", json({ action: "discard" }));
    expect(missing.status).toBe(404);
    expect(await code(missing)).toBe("capture_not_found");
    const notOpen = await app.request(`/api/review/${a.captureId}`, json({ action: "keep_shares" }));
    expect(notOpen.status).toBe(409);
    expect(await code(notOpen)).toBe("capture_action_invalid");
    const nothing = await app.request(`/api/captures/${a.captureId}/undo`, { method: "POST" });
    expect(await code(nothing)).toBe("capture_nothing_to_undo");
  });
});

describe("own-account transfer review api", () => {
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lists own_transfer items, confirms, undoes, bulk-confirms, and refuses bad bodies", async () => {
    const db = await testDb();
    await seed(db);
    const app = createApi({ getDb: () => db, today: () => "2026-10-05" });
    const [boa, chase] = await db
      .insert(accounts)
      .values([
        { userId: 1, name: "BoA checking", kind: "debit_card", institution: "Bank of America", last4: "3141", currency: "USD" },
        { userId: 1, name: "Chase savings", kind: "debit_card", institution: "Chase", last4: "5501", currency: "USD" },
      ])
      .returning();
    const leg = (p: { accountId: number; amountMinor: number; text: string; key: string; transfer?: boolean; sourceCategory?: string }) => ({
      userId: 1,
      accountId: p.accountId,
      occurredAt: "2026-10-01T12:00:00-05:00",
      occurredOn: "2026-10-01",
      amountMinor: p.amountMinor,
      currency: "USD",
      kind: p.transfer ? ("transfer" as const) : p.amountMinor < 0 ? ("expense" as const) : ("income" as const),
      counterpartyRaw: p.text,
      source: "plaid" as const,
      sourceCategory: p.sourceCategory ?? null,
      dedupKey: p.key,
    });
    const [, inn, wire] = await db
      .insert(transactions)
      .values([
        leg({ accountId: boa!.id, amountMinor: -50000, text: "CHASE DES:TRANSFER", key: "a" }),
        leg({ accountId: chase!.id, amountMinor: 50000, text: "ONLINE TRANSFER FROM BOA", key: "b" }),
        leg({ accountId: boa!.id, amountMinor: 300000, text: "WIRE IN", key: "c", transfer: true, sourceCategory: "TRANSFER_IN/TRANSFER_IN_WIRE" }),
      ])
      .returning();
    const review = async () => ReviewList.parse(await (await app.request("/api/review")).json());
    const queue = await review();
    expect(queue.counts.own_transfer).toBe(2);
    expect(queue.items.map((i) => i.type === "own_transfer" && [i.transactionId, i.proposal.rule, i.proposal.confidence]).sort()).toEqual([
      [inn!.id, "pair", "high"],
      [wire!.id, "hint", "medium"],
    ]);

    const done = TransactionReviewResult.parse(await (await app.request(`/api/review/transactions/${inn!.id}`, json({ action: "own_transfer" }))).json());
    expect(done).toMatchObject({ transactionId: inn!.id, kind: "transfer", prior: { kind: "income" } });
    expect((await review()).counts.own_transfer).toBe(1);
    const undone = await app.request(`/api/review/transactions/${inn!.id}/undo`, json({ action: "own_transfer", prior: done.prior }));
    expect(TransactionReviewResult.parse(await undone.json()).kind).toBe("income");
    const bulk = await app.request("/api/review/transactions/bulk", json({ transactionIds: [inn!.id, wire!.id], action: "own_transfer" }));
    expect(BulkTransactionReviewResult.parse(await bulk.json()).results.map((r) => r.kind)).toEqual(["transfer", "transfer"]);
    expect((await review()).total).toBe(0);

    const code = async (res: Response) => ApiError.parse(await res.json()).code;
    const noCategory = await app.request(`/api/review/transactions/${inn!.id}`, json({ action: "income" }));
    expect(noCategory.status).toBe(400);
    const gone = await app.request(`/api/review/transactions/${inn!.id}`, json({ action: "own_transfer" }));
    expect([gone.status, await code(gone)]).toEqual([409, "review_item_gone"]);
    const missing = await app.request("/api/review/transactions/999", json({ action: "dismiss" }));
    expect(missing.status).toBe(404);
  });

  it("settles a repayment item with its items and undoes it by deleting the settlement", async () => {
    const db = await testDb();
    await seed(db);
    const app = createApi({ getDb: () => db, today: () => "2026-10-05" });
    const jordan = Participant.parse(await (await app.request("/api/participants", json({ name: "Jordan Park", identities: [{ kind: "zelle_name", value: "Jordan Park" }] }))).json());
    const [boa] = await db.insert(accounts).values({ userId: 1, name: "BoA checking", kind: "debit_card", institution: "Bank of America", last4: "3141", currency: "USD" }).returning();
    const row = (p: { amountMinor: number; key: string; day: string; zelle?: boolean }) => ({
      userId: 1,
      accountId: boa!.id,
      occurredAt: `2026-10-0${p.day}T12:00:00-05:00`,
      occurredOn: `2026-10-0${p.day}`,
      amountMinor: p.amountMinor,
      currency: "USD",
      kind: p.amountMinor < 0 ? ("expense" as const) : ("income" as const),
      counterpartyRaw: p.zelle ? "Jordan Park" : "Corner Cafe",
      source: "boa_csv" as const,
      sourceCategory: p.zelle ? "Zelle" : "Purchase",
      dedupKey: p.key,
    });
    const [dinner, pay] = await db.insert(transactions).values([row({ amountMinor: -6000, key: "d", day: "1" }), row({ amountMinor: 3000, key: "p", day: "3", zelle: true })]).returning();
    await app.request(`/api/transactions/${dinner!.id}/toggle-participant`, json({ participantId: jordan.id }));

    const queue = ReviewList.parse(await (await app.request("/api/review")).json());
    const item = queue.items.find((i) => i.type === "repayment");
    expect(item).toMatchObject({ transactionId: pay!.id, proposal: { participantId: jordan.id, itemTransactionIds: [dinner!.id], confidence: "high", balanceAfterMinor: 0 } });
    expect((await app.request(`/api/review/transactions/${pay!.id}`, json({ action: "settle" }))).status).toBe(400);
    const settled = TransactionReviewResult.parse(
      await (await app.request(`/api/review/transactions/${pay!.id}`, json({ action: "settle", participantId: jordan.id, itemTransactionIds: [dinner!.id] }))).json(),
    );
    expect(settled).toMatchObject({ kind: "transfer", settlementId: expect.any(Number) });
    expect(ReviewList.parse(await (await app.request("/api/review")).json()).total).toBe(0);
    expect((await app.request(`/api/settlements/${settled.settlementId}`, { method: "DELETE" })).status).toBe(200);
    expect(ReviewList.parse(await (await app.request("/api/review")).json()).counts.repayment).toBe(1);
  });

  it("stores names on my transfers on the self participant, only of the transfer kinds", async () => {
    const db = await testDb();
    await seed(db);
    const app = createApi({ getDb: () => db });
    const me = ParticipantList.parse(await (await app.request("/api/participants")).json()).participants.find((p) => p.isSelf)!;
    const added = await app.request(`/api/participants/${me.id}/identities`, json({ kind: "bank_name", value: "Sam Rivera" }));
    expect(Identity.parse(await added.json())).toMatchObject({ participantId: me.id, kind: "bank_name", normalized: "sam rivera" });
    const email = await app.request(`/api/participants/${me.id}/identities`, json({ kind: "zelle_email", value: "sam@example.com" }));
    expect([email.status, ApiError.parse(await email.json()).code]).toEqual([400, "identity_self_kind"]);
  });
});
