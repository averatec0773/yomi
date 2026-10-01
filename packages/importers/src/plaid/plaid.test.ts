import { describe, expect, it } from "vitest";
import { createPlaidClient, PlaidApiError } from "./client";
import { plaidAmountToMinor, plaidToNormalizedRows } from "./map";
import type { PlaidAccount, PlaidTransaction, PlaidTransactionsSyncPage } from "./types";

// Shapes copied from https://plaid.com/docs/api/accounts/ and /api/products/transactions/; values synthetic.
const card: PlaidAccount = {
  account_id: "acc_card",
  name: "Customized Cash Rewards",
  official_name: "Bank of America Customized Cash Rewards Visa",
  mask: "4321",
  type: "credit",
  subtype: "credit card",
  balances: { iso_currency_code: "USD", unofficial_currency_code: null },
};
const checking: PlaidAccount = { ...card, account_id: "acc_chk", name: "Adv Plus Banking", mask: "9876", type: "depository", subtype: "checking" };

function tx(p: Partial<PlaidTransaction> & Pick<PlaidTransaction, "transaction_id" | "amount" | "name">): PlaidTransaction {
  return {
    account_id: card.account_id,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-09-10",
    authorized_date: null,
    pending: false,
    pending_transaction_id: null,
    merchant_name: null,
    personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE" },
    payment_channel: "in store",
    ...p,
  };
}

const pfc = (primary: string, detailed: string) => ({ personal_finance_category: { primary, detailed } });

describe("plaidToNormalizedRows", () => {
  it("card: purchase is money out, refund is money in, bill payment is a transfer; pending skipped", () => {
    const rows = plaidToNormalizedRows(
      [card, checking],
      [
        tx({
          transaction_id: "p1",
          amount: 86.46,
          name: "HEB #123 AUSTIN TX",
          merchant_name: "H-E-B",
          authorized_date: "2026-09-09",
          ...pfc("FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"),
        }),
        tx({ transaction_id: "r1", amount: -12.3, name: "AMAZON MKTPL REFUND", merchant_name: "Amazon" }),
        tx({ transaction_id: "pay1", amount: -500, name: "PAYMENT - THANK YOU", ...pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") }),
        tx({ transaction_id: "pend", amount: 5, name: "STARBUCKS", pending: true }),
      ],
      { institutionName: "Bank of America" },
    );
    expect(rows.map((r) => [r.externalId, r.amountMinor, r.kind, r.direction])).toEqual([
      ["p1", -8646, "expense", "out"],
      ["r1", 1230, "refund", "in"],
      ["pay1", 50000, "transfer", "neutral"],
    ]);
    const r = rows[0]!;
    expect(r.source).toBe("plaid");
    expect(r.occurredAt).toBe("2026-09-09T12:00:00-05:00");
    expect(r.currency).toBe("USD");
    expect(r.counterparty).toBe("H-E-B");
    expect(r.description).toBe("HEB #123 AUSTIN TX");
    expect(r.sourceCategory).toBe("FOOD_AND_DRINK/FOOD_AND_DRINK_GROCERIES");
    expect(r.paymentMethod).toBe("Bank of America Customized Cash Rewards (4321)");
    expect(rows[1]!.occurredAt).toBe("2026-09-10T12:00:00-05:00");
  });

  it("checking: deposit is income, card payment and own transfer are transfers, Zelle stays expense", () => {
    const on = { account_id: checking.account_id };
    const rows = plaidToNormalizedRows(
      [card, checking],
      [
        tx({ ...on, transaction_id: "t1", amount: 42.1, name: "CHECKCARD 0910 TRADER JOES", merchant_name: "Trader Joe's" }),
        tx({ ...on, transaction_id: "t2", amount: -2500, name: "ACME CORP DES:PAYROLL", ...pfc("INCOME", "INCOME_SALARY") }),
        tx({ ...on, transaction_id: "t3", amount: 500, name: "BK OF AMER CRD 4321 PAYMENT", ...pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") }),
        tx({ ...on, transaction_id: "t4", amount: -86.46, name: "Online Banking transfer from SAV 1111", ...pfc("TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER") }),
        tx({ ...on, transaction_id: "t5", amount: 30, name: "Zelle payment to FRIEND", ...pfc("TRANSFER_OUT", "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS") }),
        tx({ ...on, transaction_id: "t6", amount: -30, name: "Zelle payment from FRIEND", ...pfc("TRANSFER_IN", "TRANSFER_IN_TRANSFER_IN_FROM_APPS") }),
        tx({ ...on, transaction_id: "t7", amount: 80, name: "COMCAST AUTOPAY", ...pfc("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_INTERNET_AND_CABLE") }),
      ],
      { institutionName: "Bank of America" },
    );
    expect(rows.map((r) => [r.externalId, r.amountMinor, r.kind])).toEqual([
      ["t1", -4210, "expense"],
      ["t2", 250000, "income"],
      ["t3", -50000, "transfer"],
      ["t4", 8646, "transfer"],
      ["t5", -3000, "expense"],
      ["t6", 3000, "income"],
      ["t7", -8000, "expense"],
    ]);
    expect(rows[0]!.paymentMethod).toBe("Bank of America Adv Plus Banking (9876)");
  });

  it("converts JSON numbers to cents without float drift, and falls back to the unofficial currency", () => {
    expect([0.1, 0.29, 19.9, 1234567.89, 1.005 - 0.005, -0.07, 0].map(plaidAmountToMinor)).toEqual([-10, -29, -1990, -123456789, -100, 7, 0]);
    expect(Object.is(plaidAmountToMinor(0), 0)).toBe(true);
    const [r] = plaidToNormalizedRows([], [tx({ transaction_id: "x", amount: 1, name: "X", iso_currency_code: null, unofficial_currency_code: "usdc" })]);
    expect(r!.currency).toBe("USDC");
    expect(r!.paymentMethod).toBeNull();
  });
});

describe("PlaidClient", () => {
  function fakeFetch(handler: (path: string, body: Record<string, unknown>) => { status?: number; json: unknown }) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      const out = handler(new URL(String(url)).pathname, body);
      return new Response(JSON.stringify(out.json), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { f, calls };
  }

  const page = (p: Partial<PlaidTransactionsSyncPage>): PlaidTransactionsSyncPage => ({
    added: [],
    modified: [],
    removed: [],
    accounts: [card],
    next_cursor: "",
    has_more: false,
    request_id: "r",
    ...p,
  });

  it("sends client_id and secret in the body to the environment's host", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { link_token: "link-sandbox-1", expiration: "x" } }));
    const c = createPlaidClient({ clientId: "cid", secret: "sec", environment: "sandbox", fetch: f });
    await c.linkTokenCreate({ clientUserId: "1", clientName: "yomi" });
    expect(calls[0]!.url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(calls[0]!.body).toMatchObject({
      client_id: "cid",
      secret: "sec",
      client_name: "yomi",
      country_codes: ["US"],
      language: "en",
      products: ["transactions"],
      user: { client_user_id: "1" },
    });
    // Update mode: access_token, no products.
    await c.linkTokenCreate({ clientUserId: "1", clientName: "yomi", accessToken: "access-1" });
    expect(calls[1]!.body.access_token).toBe("access-1");
    expect(calls[1]!.body.products).toBeUndefined();
    const prod = fakeFetch(() => ({ json: {} }));
    await createPlaidClient({ clientId: "a", secret: "b", environment: "production", fetch: prod.f }).itemRemove("access-2");
    expect(prod.calls[0]).toEqual({ url: "https://production.plaid.com/item/remove", body: { client_id: "a", secret: "b", access_token: "access-2" } });
  });

  it("follows has_more and returns the last cursor", async () => {
    const pages: Record<string, PlaidTransactionsSyncPage> = {
      start: page({ added: [tx({ transaction_id: "a", amount: 1, name: "A" })], next_cursor: "c1", has_more: true }),
      c1: page({ added: [tx({ transaction_id: "b", amount: 2, name: "B" })], removed: [{ transaction_id: "z", account_id: "acc_card" }], next_cursor: "c2", has_more: true }),
      c2: page({ modified: [tx({ transaction_id: "a", amount: 1.5, name: "A" })], next_cursor: "c3", has_more: false }),
    };
    const { f, calls } = fakeFetch((_p, b) => ({ json: pages[(b.cursor as string | undefined) ?? "start"] }));
    const out = await createPlaidClient({ clientId: "c", secret: "s", environment: "sandbox", fetch: f }).transactionsSync("tok", null);
    expect(calls.map((c) => c.body.cursor ?? null)).toEqual([null, "c1", "c2"]);
    expect(out.added.map((t) => t.transaction_id)).toEqual(["a", "b"]);
    expect(out.modified.map((t) => t.amount)).toEqual([1.5]);
    expect(out.removed.map((t) => t.transaction_id)).toEqual(["z"]);
    expect(out.nextCursor).toBe("c3");
  });

  it("restarts from the first cursor on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION; keeps the cursor while data is not ready", async () => {
    let failed = false;
    const { f, calls } = fakeFetch((_p, b) => {
      if (b.cursor === "c0") return { json: page({ added: [tx({ transaction_id: "a", amount: 1, name: "A" })], next_cursor: "c1", has_more: true }) };
      if (!failed) {
        failed = true;
        return { status: 400, json: { error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_message: "m", display_message: null } };
      }
      return { json: page({ next_cursor: "c2" }) };
    });
    const c = createPlaidClient({ clientId: "c", secret: "s", environment: "sandbox", fetch: f });
    const out = await c.transactionsSync("tok", "c0");
    expect(calls.map((x) => x.body.cursor)).toEqual(["c0", "c1", "c0", "c1"]);
    expect(out.added).toHaveLength(1);
    expect(out.nextCursor).toBe("c2");

    const empty = fakeFetch(() => ({ json: page({ next_cursor: "", transactions_update_status: "NOT_READY" }) }));
    const r = await createPlaidClient({ clientId: "c", secret: "s", environment: "sandbox", fetch: empty.f }).transactionsSync("tok", null);
    expect(r).toMatchObject({ nextCursor: null, updateStatus: "NOT_READY", added: [] });
  });

  it("maps error bodies to PlaidApiError", async () => {
    const { f } = fakeFetch(() => ({
      status: 400,
      json: {
        error_type: "ITEM_ERROR",
        error_code: "ITEM_LOGIN_REQUIRED",
        error_message: "the login details of this item have changed",
        display_message: null,
        request_id: "r",
      },
    }));
    const err = await createPlaidClient({ clientId: "c", secret: "s", environment: "sandbox", fetch: f })
      .accountsGet("tok")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidApiError);
    expect(err).toMatchObject({ status: 400, type: "ITEM_ERROR", code: "ITEM_LOGIN_REQUIRED" });
    expect((err as Error).message).not.toContain("sec");
  });
});
