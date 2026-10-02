import { ApiError, ImportResult, QuickCreated, ResolveResult, ReviewList, TransactionPage } from "@yomi/contracts";
import { seed } from "@yomi/core";
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
    expect(queue.counts).toEqual({ ambiguous: 2, near_miss: 0, stale: 0, amount_changed: 0 });
    const item = queue.items.find((i) => i.captureId === a.captureId)!;
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
