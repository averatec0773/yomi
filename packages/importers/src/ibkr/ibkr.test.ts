import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFlexClient, FLEX_GET_STATEMENT_URL, FLEX_SEND_REQUEST_URL, FlexError, readFlexAnswer } from "./client";
import { flexDate, mapFlexStatement } from "./map";

const xml = readFileSync(new URL("../../test/fixtures/ibkr/flex-activity.xml", import.meta.url), "utf8");

const sendOk = (ref = "1234567890", url = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement") =>
  `<FlexStatementResponse timestamp="28 September, 2026 08:30 PM EDT"><Status>Success</Status><ReferenceCode>${ref}</ReferenceCode><Url>${url}</Url></FlexStatementResponse>`;
const fail = (code: string, msg = "x") =>
  `<FlexStatementResponse timestamp="28 September, 2026 08:30 PM EDT"><Status>Fail</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${msg}</ErrorMessage></FlexStatementResponse>`;

/** Scripted Flex server: answers in order, records every request. */
function fakeFlex(answers: (string | { status: number; body: string })[]) {
  const calls: { url: URL; ua: string | null }[] = [];
  const sleeps: number[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(u)), ua: new Headers(init?.headers).get("user-agent") });
    const a = answers.shift();
    if (a === undefined) throw new Error("no more answers");
    return typeof a === "string" ? new Response(a, { status: 200 }) : new Response(a.body, { status: a.status });
  }) as typeof fetch;
  const client = (o: Partial<Parameters<typeof createFlexClient>[0]> = {}) =>
    createFlexClient({ token: "tok123", queryId: "987654", fetch: f, sleep: async (ms) => void sleeps.push(ms), ...o });
  return { calls, sleeps, client };
}

describe("Flex client polling", () => {
  it("sends the token, query and v=3 with a Java User-Agent, then polls GetStatement while 1019", async () => {
    const s = fakeFlex([sendOk(), fail("1019", "Statement generation in progress. Please try again shortly."), fail("1019"), xml]);
    const out = await s.client().fetchStatement();
    expect(out).toContain("<FlexQueryResponse");
    expect(s.calls.map((c) => `${c.url.origin}${c.url.pathname}`)).toEqual([FLEX_SEND_REQUEST_URL, FLEX_GET_STATEMENT_URL, FLEX_GET_STATEMENT_URL, FLEX_GET_STATEMENT_URL]);
    expect(Object.fromEntries(s.calls[0]!.url.searchParams)).toEqual({ t: "tok123", q: "987654", v: "3" });
    expect(Object.fromEntries(s.calls[1]!.url.searchParams)).toEqual({ t: "tok123", q: "1234567890", v: "3" });
    expect(s.calls.every((c) => c.ua === "Java")).toBe(true);
    // initial pause, then doubling backoff
    expect(s.sleeps).toEqual([5000, 5000, 10000]);
  });

  it("retries SendRequest on 1018 (rate limit) with at least 10 s", async () => {
    const s = fakeFlex([fail("1018"), sendOk(), xml]);
    await s.client().fetchStatement();
    expect(s.sleeps[0]).toBe(10000);
  });

  it("gives up with in_progress_timeout after maxWait", async () => {
    const s = fakeFlex([sendOk(), ...Array.from({ length: 20 }, () => fail("1019"))]);
    const err = await s.client({ maxWaitMs: 30_000 }).fetchStatement().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlexError);
    expect((err as FlexError).kind).toBe("in_progress_timeout");
    expect((err as FlexError).flexCode).toBe("1019");
  });

  it("maps token expired / invalid / IP restriction / invalid query to kinds without retrying", async () => {
    for (const [code, kind] of [
      ["1012", "token_expired"],
      ["1015", "token_invalid"],
      ["1013", "ip_restricted"],
      ["1014", "query_invalid"],
    ] as const) {
      const s = fakeFlex([fail(code)]);
      const err = (await s.client().fetchStatement().catch((e: unknown) => e)) as FlexError;
      expect([err.kind, err.flexCode, s.calls.length, err.code.startsWith("invest_ibkr_"), err.params.flexCode]).toEqual([kind, code, 1, true, code]);
      expect(err.message).not.toContain("tok123");
    }
  });

  it("treats HTTP errors and non-XML as unavailable", async () => {
    const s = fakeFlex([{ status: 503, body: "busy" }]);
    expect(((await s.client().fetchStatement().catch((e: unknown) => e)) as FlexError).kind).toBe("unavailable");
    expect(() => readFlexAnswer("<html")).toThrow(FlexError);
  });

  it("follows only IBKR hosts for the GetStatement URL", async () => {
    const s = fakeFlex([sendOk("1", "https://evil.example.com/steal"), xml]);
    await s.client().fetchStatement();
    expect(s.calls[1]!.url.hostname).toBe("ndcdyn.interactivebrokers.com");
    const t = fakeFlex([sendOk("1", "https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?x=1"), xml]);
    await t.client().fetchStatement();
    expect(t.calls[1]!.url.hostname).toBe("gdcdyn.interactivebrokers.com");
    expect(t.calls[1]!.url.searchParams.get("x")).toBeNull();
  });
});

describe("Flex XML mapping", () => {
  const st = mapFlexStatement(xml);

  it("reads the account, as-of date and summary positions only", () => {
    expect(st.source).toBe("ibkr");
    expect(st.asOf).toBe("2026-09-28");
    expect(st.accounts).toEqual([{ externalId: "U0000001", name: "Test IBKR", currency: "USD" }]);
    const pos = st.holdings.filter((h) => h.securityExternalId);
    expect(pos.map((h) => [h.securityExternalId, h.currency, h.quantity, h.price, h.marketValue, h.costBasis])).toEqual([
      ["265598", "USD", "10.5", "227.1234", "2384.7957", "2000.123456"],
      ["37196556", "HKD", "100", "420.2", "42020", "38000"],
      ["712345678", "USD", "2", "3.45", "690", "1020"],
      ["1111", "USD", "-5", "12.5", "-62.5", "-70"],
    ]);
  });

  it("keeps the option multiplier and identifiers", () => {
    const opt = st.securities.find((s) => s.externalId === "712345678")!;
    expect(opt).toMatchObject({ type: "OPT", multiplier: "100", currency: "USD" });
    expect(st.securities.find((s) => s.externalId === "265598")).toMatchObject({ symbol: "AAPL", isin: "US0378331005", multiplier: null });
    expect(st.securities.find((s) => s.externalId === "1111")!.name).toBe("SHORT CO & SONS");
  });

  it("reads ending cash per currency and skips BASE_SUMMARY", () => {
    const cash = st.holdings.filter((h) => !h.securityExternalId);
    expect(cash.map((h) => [h.currency, h.quantity, h.marketValue, h.costBasis])).toEqual([
      ["USD", "4102.335", "4102.335", null],
      ["HKD", "8850.1", "8850.1", null],
    ]);
  });

  it("maps executions and cash transactions with cash-in positive", () => {
    expect(st.transactions.map((t) => [t.externalId, t.date, t.type, t.quantity, t.amount, t.currency])).toEqual([
      ["trade:7000001", "2026-09-26", "buy", "0.5", "-113.6", "USD"],
      ["trade:7000002", "2026-09-28", "sell", "-100", "42082", "HKD"],
      ["cash:8000001", "2026-09-25", "dividend", null, "2.73", "USD"],
      ["cash:8000002", "2026-09-25", "fee", null, "-0.82", "USD"],
      ["cash:8000003", "2026-09-28", "interest", null, "1.05", "USD"],
    ]);
    expect(st.transactions[4]!.securityExternalId).toBeNull();
  });

  it("parses the Flex date formats", () => {
    expect(flexDate("20260928")).toBe("2026-09-28");
    expect(flexDate("2026-09-28;160000")).toBe("2026-09-28");
    expect(flexDate("09/28/2026")).toBe("2026-09-28");
    expect(flexDate("")).toBeNull();
  });

  it("rejects a FlexStatementResponse passed as a statement", () => {
    expect(() => mapFlexStatement(fail("1019"))).toThrow(FlexError);
  });
});
