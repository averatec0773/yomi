import {
  AcceptSuggestionsResult,
  ApiError,
  DismissSuggestionResult,
  MerchantSuggestResult,
  RevertSuggestionsResult,
  BalanceList,
  BulkToggleResult,
  CandidateList,
  ApplyAutoSplitResult,
  ClaimCounterpartyResult,
  CreatedEntry,
  Identity,
  MerchantRule,
  MerchantRuleList,
  OpenItemList,
  Participant,
  ParticipantList,
  QuickDraft,
  Settlement,
  SettlementList,
  SharedNote,
  SplitResult,
  Statement,
  SuggestionList,
  TransactionPage,
  UnclaimedCounterpartyList,
  UnsplitSummary,
  DEFAULT_STATEMENT_FLAGS,
} from "@yomi/contracts";
import { DEFAULT_STATEMENT_FLAGS as CORE_DEFAULT_STATEMENT_FLAGS, seed } from "@yomi/core";
import { accounts, transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

async function setup() {
  const db = await testDb();
  await seed(db);
  const app = createApi({ getDb: () => db, parse: async () => ({ source: "wechat", rows: [], declared: {}, warnings: [] }) });
  let n = 0;
  const addTx = async (amountMinor: number, extra: Partial<typeof transactions.$inferInsert> = {}) =>
    (
      await db
        .insert(transactions)
        .values({
          userId: 1,
          occurredAt: "2026-09-10T12:00:00+08:00",
          amountMinor,
          currency: "CNY",
          kind: amountMinor < 0 ? "expense" : "income",
          merchant: "盒马",
          source: "wechat",
          dedupKey: `api:${++n}`,
          ...extra,
        })
        .returning({ id: transactions.id })
    )[0]!.id;
  const json = (method: string, body: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { app, addTx, json, db };
}

describe("split api", () => {
  it("counterparties: list, claim into a new participant, ignore", async () => {
    const { app, addTx, json } = await setup();
    const now = new Date().toISOString();
    const t = await addTx(5000, { counterpartyRaw: "Momo", sourceCategory: "转账", occurredAt: now });
    await addTx(-2000, { counterpartyRaw: "Momo", sourceCategory: "转账", occurredAt: now });
    await addTx(700, { counterpartyRaw: "路人", sourceCategory: "微信红包", occurredAt: now });
    await addTx(-900, { counterpartyRaw: "盒马", sourceCategory: "商户消费", occurredAt: now });
    const list = async () => UnclaimedCounterpartyList.parse(await (await app.request("/api/split/counterparties")).json()).counterparties;
    const first = await list();
    expect(first.map((c) => [c.kind, c.value, c.inCount, c.outCount])).toEqual([
      ["wechat", "Momo", 1, 1],
      ["wechat", "路人", 1, 0],
    ]);
    expect(first[0]!.totals).toEqual([{ currency: "CNY", inMinor: 5000, outMinor: 2000 }]);

    expect((await app.request("/api/split/counterparties/claim", json("POST", { kind: "wechat", value: "Momo" }))).status).toBe(400);
    const claimed = await app.request("/api/split/counterparties/claim", json("POST", { kind: "wechat", value: "Momo", newParticipantName: "莫莫" }));
    expect(claimed.status).toBe(201);
    const out = ClaimCounterpartyResult.parse(await claimed.json());
    expect(out.identity).toMatchObject({ kind: "wechat", value: "Momo", source: "claimed" });
    const cands = CandidateList.parse(await (await app.request("/api/split/candidates")).json()).candidates;
    expect(cands.find((c) => c.transactionId === t)).toMatchObject({ suggestedParticipantId: out.participantId, match: "alias_exact" });

    expect((await app.request("/api/split/counterparties/ignore", json("POST", { kind: "wechat", value: "路人" }))).status).toBe(200);
    expect(await list()).toEqual([]);
  });

  it("participants CRUD", async () => {
    const { app, json } = await setup();
    const created = await app.request("/api/participants", json("POST", { name: "室友", identities: [{ kind: "wechat", value: "Wang" }] }));
    expect(created.status).toBe(201);
    const p = Participant.parse(await created.json());
    expect((await app.request("/api/participants", json("POST", { name: "室友" }))).status).toBe(409);
    expect((await app.request("/api/participants", json("POST", { name: "" }))).status).toBe(400);
    expect(p.identities.map((i) => [i.kind, i.value, i.normalized])).toEqual([["wechat", "Wang", "wang"]]);
    const patched = await app.request(`/api/participants/${p.id}`, json("PATCH", { name: "阿王" }));
    expect(Participant.parse(await patched.json())).toMatchObject({ name: "阿王" });
    const added = await app.request(`/api/participants/${p.id}/identities`, json("POST", { kind: "zelle_phone", value: "+1 (512) 555-0100" }));
    expect(added.status).toBe(201);
    const phone = Identity.parse(await added.json());
    expect(phone.normalized).toBe("15125550100");
    expect((await app.request(`/api/participants/${p.id}/identities`, json("POST", { kind: "nope", value: "x" }))).status).toBe(400);
    expect((await app.request(`/api/participants/${p.id}/identities`, json("POST", { kind: "zelle_email", value: "not-an-email" }))).status).toBe(400);
    expect((await app.request(`/api/identities/${phone.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/identities/${phone.id}`, { method: "DELETE" })).status).toBe(404);
    const list = ParticipantList.parse(await (await app.request("/api/participants")).json());
    expect(list.participants.map((x) => x.name)).toEqual(["我", "阿王"]);
    const selfPatch = await app.request(`/api/participants/${list.participants[0]!.id}`, json("PATCH", { archived: true }));
    expect(selfPatch.status).toBe(400);
    expect(ApiError.parse(await selfPatch.json()).code).toBe("participant_self_archive");
    expect((await app.request("/api/participants/999", json("PATCH", { archived: true }))).status).toBe(404);
  });

  it("toggle, split, bulk, balances, settle-all, statement", async () => {
    const { app, addTx, json } = await setup();
    const p = Participant.parse(await (await app.request("/api/participants", json("POST", { name: "室友" }))).json());
    const t1 = await addTx(-10000);
    const t2 = await addTx(-3000);
    const toggled = SplitResult.parse(await (await app.request(`/api/transactions/${t1}/toggle-participant`, json("POST", { participantId: p.id }))).json());
    expect(toggled.split!.myShareMinor).toBe(5000);
    const exact = await app.request(`/api/transactions/${t1}/split`, json("POST", { participantIds: [p.id], mode: "exact", exact: [{ participantId: p.id, owedMinor: 20000 }] }));
    expect(exact.status).toBe(400);
    const bulk = BulkToggleResult.parse(await (await app.request("/api/split/bulk-toggle", json("POST", { transactionIds: [t1, t2], participantId: p.id, on: true }))).json());
    expect(bulk).toMatchObject({ updated: [t2], unchanged: [t1] });
    const b = BalanceList.parse(await (await app.request("/api/split/balances")).json());
    expect(b.balances).toEqual([expect.objectContaining({ participantId: p.id, currency: "CNY", owedToMeMinor: 6500, openItemCount: 2 })]);

    const st = Statement.parse(await (await app.request(`/api/split/statement?participantId=${p.id}&currency=CNY`)).json());
    expect(st.text).toContain("Total: you owe me ¥65.00");
    const zh = Statement.parse(await (await app.request(`/api/split/statement?participantId=${p.id}&currency=CNY&locale=zh-CN`)).json());
    expect(zh.text).toContain("合计：你欠我 ¥65.00");
    expect((await app.request(`/api/split/statement?participantId=${p.id}&currency=CNY&locale=fr`)).status).toBe(400);
    expect((await app.request(`/api/split/statement?participantId=abc&currency=CNY`)).status).toBe(400);

    // Scope: selected items must be this person's; items need scope=selected and the reverse.
    const other = Participant.parse(await (await app.request("/api/participants", json("POST", { name: "Li" }))).json());
    const t3 = await addTx(-2000);
    await app.request(`/api/transactions/${t3}/toggle-participant`, json("POST", { participantId: other.id }));
    const base = `/api/split/statement?participantId=${p.id}&currency=CNY`;
    const sel = Statement.parse(await (await app.request(`${base}&scope=selected&items=${t2}`)).json());
    expect(sel).toMatchObject({ scope: "selected", scopeRemainingMinor: 1500 });
    expect(sel.text).toContain("Selected 1 item");
    const foreign = await app.request(`${base}&scope=selected&items=${t2},${t3}`);
    expect(foreign.status).toBe(400);
    expect(ApiError.parse(await foreign.json()).code).toBe("statement_items_invalid");
    expect((await app.request(`${base}&scope=selected`)).status).toBe(400);
    expect((await app.request(`${base}&items=${t2}`)).status).toBe(400);
    expect((await app.request(`${base}&scope=selected&items=1,x`)).status).toBe(400);
    expect(Statement.parse(await (await app.request(`${base}&scope=all`)).json()).scopeItems).toHaveLength(2);

    // Options: absent means the defaults; names brings shared; empty shows none; unknown flags are refused.
    expect(Statement.parse(await (await app.request(base)).json()).show).toEqual([...DEFAULT_STATEMENT_FLAGS]);
    expect(DEFAULT_STATEMENT_FLAGS).toEqual(CORE_DEFAULT_STATEMENT_FLAGS);
    expect(Statement.parse(await (await app.request(`${base}&show=category,names`)).json()).show).toEqual(["shared", "names", "category"]);
    expect(Statement.parse(await (await app.request(`${base}&show=`)).json()).show).toEqual([]);
    for (const bad of ["everything", "names,,notes", "Names"]) {
      const r = await app.request(`${base}&show=${bad}`);
      expect(r.status).toBe(400);
      expect(ApiError.parse(await r.json()).code).toBe("validation_failed");
    }
    const csv = await (await app.request(`/api/export/split.csv?participantId=${p.id}&currency=CNY&show=myshare`)).text();
    expect(csv.split("\r\n")[0]).toMatch(/,Note,My share$/);
    expect((await app.request(`/api/export/split.csv?participantId=${p.id}&currency=CNY&show=all`)).status).toBe(400);

    const settle = await app.request("/api/split/settle-all", json("POST", { participantId: p.id, currency: "CNY", settledOn: "2026-09-20" }));
    expect(settle.status).toBe(201);
    const s = Settlement.parse(await settle.json());
    expect(s.amountMinor).toBe(6500);
    const list = SettlementList.parse(await (await app.request(`/api/settlements?participantId=${p.id}`)).json());
    expect(list.settlements).toHaveLength(1);
    expect((await app.request(`/api/settlements/${s.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/settlements/${s.id}`, { method: "DELETE" })).status).toBe(404);
    const manual = await app.request("/api/settlements", json("POST", { participantId: p.id, amountMinor: 500, currency: "cny", settledOn: "2026-09-21" }));
    expect(Settlement.parse(await manual.json()).currency).toBe("CNY");
  });

  it("open items, settling chosen items with a rate, shared notes", async () => {
    const { app, addTx, json } = await setup();
    const p = Participant.parse(await (await app.request("/api/participants", json("POST", { name: "室友" }))).json());
    const t1 = await addTx(-10000, { occurredAt: "2026-08-01T12:00:00+08:00" });
    const t2 = await addTx(-4000);
    for (const t of [t1, t2]) await app.request(`/api/transactions/${t}/toggle-participant`, json("POST", { participantId: p.id }));
    const open = OpenItemList.parse(await (await app.request(`/api/split/open-items?participantId=${p.id}&currency=CNY`)).json());
    expect(open.items.map((i) => [i.transactionId, i.remainingMinor, i.status])).toEqual([
      [t1, 5000, "open"],
      [t2, 2000, "open"],
    ]);
    expect((await app.request(`/api/split/open-items?participantId=${p.id}`)).status).toBe(400);

    const res = await app.request(
      "/api/settlements",
      json("POST", { participantId: p.id, amountMinor: 5000, currency: "CNY", settledOn: "2026-09-20", itemTransactionIds: [t1], originalCurrency: "USD", fxRate: "0.1389" }),
    );
    expect(res.status).toBe(201);
    expect(Settlement.parse(await res.json())).toMatchObject({ originalAmountMinor: 695, originalCurrency: "USD", fxRate: "0.1389" });
    const after = OpenItemList.parse(await (await app.request(`/api/split/open-items?participantId=${p.id}&currency=CNY`)).json());
    expect(after.items.map((i) => i.transactionId)).toEqual([t2]);
    const again = await app.request("/api/settlements", json("POST", { participantId: p.id, amountMinor: 100, currency: "CNY", settledOn: "2026-09-20", itemTransactionIds: [t1] }));
    expect(again.status).toBe(400);
    expect(ApiError.parse(await again.json()).code).toBe("settlement_item_not_open");
    expect((await app.request("/api/settlements", json("POST", { participantId: p.id, amountMinor: 100, currency: "CNY", settledOn: "2026-09-20", originalCurrency: "USD", fxRate: "7,2" }))).status).toBe(400);

    const put = await app.request(`/api/transactions/${t2}/shared-note`, json("PUT", { sharedNote: " 含纸巾 " }));
    expect(SharedNote.parse(await put.json())).toEqual({ transactionId: t2, sharedNote: "含纸巾" });
    expect(SharedNote.parse(await (await app.request(`/api/transactions/${t2}/shared-note`)).json()).sharedNote).toBe("含纸巾");
    expect((await app.request("/api/transactions/9999/shared-note")).status).toBe(404);
    const st = Statement.parse(await (await app.request(`/api/split/statement?participantId=${p.id}&currency=CNY&locale=zh-CN&recentSince=2026-09-01`)).json());
    expect(st.openItems.map((i) => [i.transactionId, i.sharedNote])).toEqual([[t2, "含纸巾"]]);
    expect(st.recentSettlements[0]!.items.map((i) => i.transactionId)).toEqual([t1]);
    expect(st.text).toContain("  备注：含纸巾");
  });

  it("opening balance and clear-before", async () => {
    const { app, addTx, json } = await setup();
    const p = Participant.parse(await (await app.request("/api/participants", json("POST", { name: "室友" }))).json());
    const res = await app.request("/api/split/opening-balance", json("POST", { participantId: p.id, direction: "they_owe_me", amountMinor: 18250, currency: "usd", date: "2026-09-01" }));
    expect(res.status).toBe(201);
    expect(Settlement.parse(await res.json())).toMatchObject({ amountMinor: -18250, currency: "USD", note: null, opening: true });
    const b = BalanceList.parse(await (await app.request("/api/split/balances")).json());
    expect(b.balances).toEqual([expect.objectContaining({ currency: "USD", owedToMeMinor: 18250 })]);
    const st = Statement.parse(await (await app.request(`/api/split/statement?participantId=${p.id}&currency=USD`)).json());
    expect(st.text).toContain("Opening balance: you owe me $182.50");
    expect((await app.request("/api/split/opening-balance", json("POST", { participantId: p.id, direction: "they_owe_me", amountMinor: -1, currency: "USD", date: "2026-09-01" }))).status).toBe(400);

    const t = await addTx(-1000, { occurredAt: "2026-08-01T12:00:00+08:00" });
    await app.request(`/api/transactions/${t}/toggle-participant`, json("POST", { participantId: p.id }));
    const cleared = await app.request("/api/split/clear-before", json("POST", { participantId: p.id, currency: "CNY", from: "2026-09-01" }));
    expect(cleared.status).toBe(201);
    expect(Settlement.parse(await cleared.json())).toMatchObject({ amountMinor: 500, settledOn: "2026-08-31", opening: false });
    expect((await app.request("/api/split/clear-before", json("POST", { participantId: p.id, currency: "CNY", from: "2026-09-01" }))).status).toBe(400);
  });

  it("candidates, mark-settlement, friend-paid, suggestions", async () => {
    const { app, addTx, json } = await setup();
    const p = Participant.parse(await (await app.request("/api/participants", json("POST", { name: "室友", identities: [{ kind: "wechat", value: "Wang" }] }))).json());
    const fp = await app.request("/api/split/friend-paid", json("POST", { payerId: p.id, totalMinor: 8000, currency: "CNY", occurredAt: "2026-09-01", description: "电费" }));
    expect(fp.status).toBe(201);
    expect(CreatedEntry.parse(await fp.json()).myShareMinor).toBe(4000);
    const incoming = await addTx(4000, { counterpartyRaw: "Wang", sourceCategory: "转账", occurredAt: new Date().toISOString() });
    const cands = CandidateList.parse(await (await app.request("/api/split/candidates")).json());
    expect(cands.candidates[0]).toMatchObject({ transactionId: incoming, suggestedParticipantId: p.id, match: "alias_exact" });
    const marked = await app.request(`/api/transactions/${incoming}/mark-settlement`, json("POST", { participantId: p.id }));
    expect(marked.status).toBe(201);
    // they sent me ¥40 although I owed them ¥40: now I owe ¥80
    const b = BalanceList.parse(await (await app.request("/api/split/balances")).json());
    expect(b.balances[0]!.owedToMeMinor).toBe(-8000);
    expect((await app.request(`/api/transactions/${incoming}/mark-settlement`, json("POST", { participantId: p.id }))).status).toBe(409);
    const sug = SuggestionList.parse(await (await app.request("/api/split/suggestions?month=2026-09")).json());
    expect(sug.suggestions).toEqual([]);
    expect((await app.request("/api/split/suggestions?month=bad")).status).toBe(400);
    expect((await app.request("/api/transactions/abc/split", json("POST", { participantIds: [] }))).status).toBe(400);
    const bad = await app.request("/api/split/friend-paid", { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
  });

  it("quick parse and create", async () => {
    const { app, json } = await setup();
    Participant.parse(await (await app.request("/api/participants", json("POST", { name: "室友" }))).json());
    const draft = QuickDraft.parse(
      await (await app.request("/api/quick/parse", json("POST", { text: "@室友 付 80 电费", today: "2026-09-29" }))).json(),
    );
    expect(draft).toMatchObject({ amountMinor: 8000, date: "2026-09-29", payerId: 2, categoryHint: "居住", errors: [] });
    const created = await app.request("/api/quick", json("POST", draft));
    expect(created.status).toBe(201);
    expect(CreatedEntry.parse(await created.json()).myShareMinor).toBe(4000);
    const missing = QuickDraft.parse(await (await app.request("/api/quick/parse", json("POST", { text: "电费" }))).json());
    expect(missing.amountMinor).toBeNull();
    expect((await app.request("/api/quick", json("POST", missing))).status).toBe(400);
  });
});

describe("unsplit triage and auto-split api", () => {
  it("summary, unsplit filter, set auto-split, apply to existing", async () => {
    const { app, addTx, json, db } = await setup();
    const accountId = (
      await db.insert(accounts).values({ userId: 1, name: "微信零钱", kind: "wallet", institution: "微信", currency: "CNY" }).returning({ id: accounts.id })
    )[0]!.id;
    const p = Participant.parse(await (await app.request("/api/participants", json("POST", { name: "室友" }))).json());
    await addTx(-1000, { accountId, merchant: "Costco", occurredAt: "2026-08-03T12:00:00+08:00" });
    await addTx(-2000, { accountId, merchant: "Costco" });
    await addTx(-300, { accountId, merchant: "便利店" });

    const summary = UnsplitSummary.parse(await (await app.request("/api/split/unsplit-summary")).json());
    expect(summary.months.map((m) => [m.month, m.count])).toEqual([
      ["2026-09", 2],
      ["2026-08", 1],
    ]);
    const page = TransactionPage.parse(await (await app.request("/api/transactions?month=2026-09&unsplit=1")).json());
    expect(page.items).toHaveLength(2);

    const bad = await app.request("/api/merchant-rules/auto-split", json("POST", { merchant: "Costco", participantIds: [], enabled: true }));
    expect(bad.status).toBe(400);
    ApiError.parse(await bad.json());
    const rule = MerchantRule.parse(
      await (await app.request("/api/merchant-rules/auto-split", json("POST", { merchant: "Costco", participantIds: [p.id], enabled: true }))).json(),
    );
    expect(rule).toMatchObject({ autoSplit: true, unsplitCount: 2, participants: [{ id: p.id, name: "室友" }] });
    const list = MerchantRuleList.parse(await (await app.request("/api/merchant-rules?autoSplit=1")).json());
    expect(list.rules.map((r) => r.merchant)).toEqual(["Costco"]);

    const applied = ApplyAutoSplitResult.parse(
      await (await app.request("/api/merchant-rules/apply-auto-split", json("POST", { merchant: "Costco" }))).json(),
    );
    expect(applied).toEqual({ merchant: "Costco", split: 2 });
    const after = UnsplitSummary.parse(await (await app.request("/api/split/unsplit-summary")).json());
    expect(after.months.map((m) => [m.month, m.count])).toEqual([["2026-09", 1]]);
    expect((await app.request("/api/merchant-rules/apply-auto-split", json("POST", { merchant: "便利店" }))).status).toBe(400);
  });

  it("accept suggestions + undo, dismiss a row, mute a merchant", async () => {
    const { app, addTx, json } = await setup();
    const p = Participant.parse(await (await app.request("/api/participants", json("POST", { name: "Alex" }))).json());
    const first = await addTx(-1000, { merchant: "Corner Shop" });
    await app.request(`/api/transactions/${first}/toggle-participant`, json("POST", { participantId: p.id }));
    const a = await addTx(-2000, { merchant: "Corner Shop" });
    const b = await addTx(-3000, { merchant: "Corner Shop" });
    const page = TransactionPage.parse(await (await app.request("/api/transactions?month=2026-09")).json());
    expect(page.items.find((t) => t.id === a)?.suggestion).toMatchObject({ source: "merchant", participantIds: [p.id] });

    const dismissed = DismissSuggestionResult.parse(
      await (await app.request(`/api/transactions/${b}/split-suggestion/dismiss`, json("POST", {}))).json(),
    );
    expect(dismissed).toEqual({ transactionId: b, dismissed: true });

    const res = AcceptSuggestionsResult.parse(
      await (await app.request("/api/split/accept-suggestions", json("POST", { transactionIds: [a, b] }))).json(),
    );
    expect(res.accepted).toEqual([{ transactionId: a, participantIds: [p.id] }]);
    expect(res.skipped.map((s) => s.transactionId)).toEqual([b]);
    const undo = RevertSuggestionsResult.parse(
      await (await app.request("/api/split/accept-suggestions/undo", json("POST", { transactionIds: [a] }))).json(),
    );
    expect(undo).toEqual({ reverted: [a] });
    expect((await app.request("/api/split/accept-suggestions", json("POST", { transactionIds: [] }))).status).toBe(400);

    const muted = MerchantSuggestResult.parse(
      await (await app.request("/api/merchant-rules/suggest", json("POST", { merchant: "Corner Shop", suggest: false }))).json(),
    );
    expect(muted).toEqual({ merchant: "Corner Shop", suggest: false, previousParticipantIds: [p.id] });
    const after = TransactionPage.parse(await (await app.request("/api/transactions?month=2026-09")).json());
    expect(after.items.every((t) => t.suggestion === null)).toBe(true);
  });
});
