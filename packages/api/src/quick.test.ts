import { ApiError, QuickAccountList, QuickCreated, QuickDraft, QuickRowsCreated } from "@yomi/contracts";
import { createParticipant, getCurrentUser, listCategories, seed } from "@yomi/core";
import { accounts, transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

async function setup() {
  const db = await testDb();
  await seed(db);
  const roomie = await createParticipant(db, getCurrentUser(), "室友");
  return { db, app: createApi({ getDb: () => db }), roomie: roomie.id };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("quick add routes", () => {
  it("parses text into a draft, then saves it split equally", async () => {
    const { db, app, roomie } = await setup();
    const res = await app.request("/api/quick/parse", post({ text: "lunch 35 @室友", today: "2026-09-29" }));
    expect(res.status).toBe(200);
    const draft = QuickDraft.parse(await res.json());
    expect(draft).toMatchObject({ amountMinor: 3500, currency: "CNY", date: "2026-09-29", participantIds: [roomie], errors: [] });
    expect(draft.sms ?? null).toBeNull();

    const created = await app.request("/api/quick", post(draft));
    expect(created.status).toBe(201);
    const entry = QuickCreated.parse(await created.json());
    expect(entry.myShareMinor).toBe(1750);
    expect(entry.split?.rows.map((r) => [r.name, r.owedMinor])).toEqual([
      ["我", 1750],
      ["室友", 1750],
    ]);
    expect((await db.select().from(transactions)).map((t) => [t.id, t.amountMinor, t.source])).toEqual([[entry.transactionId, -3500, "manual"]]);
  });

  it("reports what is missing in the draft instead of failing", async () => {
    const { app } = await setup();
    const draft = QuickDraft.parse(await (await app.request("/api/quick/parse", post({ text: "lunch @nobody", today: "2026-09-29" }))).json());
    expect(draft.amountMinor).toBeNull();
    expect(draft.errors.map((e) => e.code)).toEqual(expect.arrayContaining(["quick_missing_amount"]));
  });

  it("rejects bodies that do not match the contract with 400", async () => {
    const { app, roomie } = await setup();
    for (const [path, body] of [
      ["/api/quick/parse", { text: "" }],
      ["/api/quick/parse", { text: "lunch 35", today: "2026-9-29" }],
      ["/api/quick", { amountMinor: 0, currency: "CNY", description: "x", date: "2026-09-29", participantIds: [roomie], payerId: null, mode: "equal", categoryHint: null, errors: [] }],
      ["/api/quick", { amountMinor: 100, currency: "CNY", description: "x", date: "2026-09-29" }],
    ] as const) {
      const res = await app.request(path, post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(ApiError.parse(await res.json()).code).toBe("validation_failed");
    }
  });
});

describe("quick add with a pasted ICBC alert", () => {
  const SMS = "您尾号3141信用卡9月27日08:24POS支出(消费BUSY BEE BOBA Houston)15.74美元。【工商银行】";

  it("parses, saves once and reports a repeat paste", async () => {
    const { db, app } = await setup();
    const parsed = QuickDraft.parse(await (await app.request("/api/quick/parse", { method: "POST", body: JSON.stringify({ text: SMS, today: "2026-09-29" }) })).json());
    expect(parsed.sms).toMatchObject({ last4: "3141", merchant: "BUSY BEE BOBA", amountMinor: -1574 });
    const body = JSON.stringify({ ...parsed, errors: undefined, smsText: SMS, today: "2026-09-29" });
    const first = await app.request("/api/quick", { method: "POST", body });
    expect(first.status).toBe(201);
    expect(QuickCreated.parse(await first.json())).toMatchObject({ alreadyAdded: false, duplicateOfId: null });
    const again = await app.request("/api/quick", { method: "POST", body });
    expect(again.status).toBe(200);
    expect(QuickCreated.parse(await again.json())).toMatchObject({ alreadyAdded: true });
    expect((await db.select().from(transactions)).map((t) => t.source)).toEqual(["sms"]);
  });
});

describe("quick add income and transfers", () => {
  it("lists my accounts, saves income and a transfer pair, and answers bad requests with a code", async () => {
    const { db, app } = await setup();
    const [checking, savings] = await db
      .insert(accounts)
      .values([
        { userId: getCurrentUser().id, name: "Checking 3141", kind: "debit_card", currency: "USD" },
        { userId: getCurrentUser().id, name: "Savings 5501", kind: "debit_card", currency: "USD" },
      ])
      .returning({ id: accounts.id });
    const list = QuickAccountList.parse(await (await app.request("/api/quick/accounts")).json());
    expect(list.accounts.map((a) => a.name)).toEqual(["Checking 3141", "Savings 5501"]);

    const salary = (await listCategories(db, getCurrentUser())).find((c) => c.key === "salary")!.id;
    const income = await app.request("/api/quick/income", post({ amountMinor: 320000, currency: "usd", categoryId: salary, date: "2026-09-15", accountId: checking!.id, note: "Paycheck" }));
    expect(income.status).toBe(201);
    expect(QuickRowsCreated.parse(await income.json()).transactionIds).toHaveLength(1);

    const transfer = await app.request("/api/quick/transfer", post({ fromAccountId: checking!.id, toAccountId: savings!.id, amountMinor: 50000, date: "2026-09-12" }));
    expect(transfer.status).toBe(201);
    const [out, into] = QuickRowsCreated.parse(await transfer.json()).transactionIds;
    const peers = new Map((await db.select().from(transactions)).map((t) => [t.id, t.transferPeerId]));
    expect([peers.get(out!), peers.get(into!)]).toEqual([into, out]);

    const same = await app.request("/api/quick/transfer", post({ fromAccountId: checking!.id, toAccountId: checking!.id, amountMinor: 1, date: "2026-09-12" }));
    expect(same.status).toBe(400);
    expect(ApiError.parse(await same.json()).code).toBe("quick_transfer_same_account");
    const missing = await app.request("/api/quick/income", post({ amountMinor: 1, currency: "USD", categoryId: salary, date: "2026-09-15", accountId: 9999 }));
    expect(missing.status).toBe(404);
    const invalid = await app.request("/api/quick/income", post({ amountMinor: 1, currency: "USD", categoryId: salary, date: "2026-09-15" }));
    expect(ApiError.parse(await invalid.json()).code).toBe("validation_failed");
  });
});
