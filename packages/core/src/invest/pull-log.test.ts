import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ibkrSourceFor, ibkrTestDay, IBKR_TEST_MAX_WAIT_MS, testIbkrCredentials } from "./credentials";
import { formatFlexPullLog } from "./pull-log";

const flexXml = readFileSync(new URL("../../../importers/test/fixtures/ibkr/flex-activity.xml", import.meta.url), "utf8");
const TOKEN = "test-token-3141-abcdefgh";
const QUERY = "987123";

/** A New York wall-clock time in EDT (UTC-4), as on the author's machine. */
const ny = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(Date.parse(`${date}T00:00:00Z`) + ((h + 4) * 60 + m) * 60_000);
};

const answer = (status: string, extra: string) => new Response(`<FlexStatementResponse><Status>${status}</Status>${extra}</FlexStatementResponse>`);
const notReady = (code = "1019") => answer("Warn", `<ErrorCode>${code}</ErrorCode><ErrorMessage>Statement generation in progress</ErrorMessage>`);
const sendOk = () => answer("Success", "<ReferenceCode>77</ReferenceCode>");

describe("Test connection day", () => {
  it("asks for the weekday before the last completed trading day, which IBKR has published", () => {
    // Wednesday after 18:00: today's statement is not out until after midnight, so Tuesday.
    expect(ibkrTestDay(ny("2026-09-30", "20:41"))).toBe("2026-09-29");
    // Wednesday before 18:00: the last completed day is Tuesday, so Monday.
    expect(ibkrTestDay(ny("2026-09-30", "12:00"))).toBe("2026-09-28");
    // Monday morning: last completed is Friday, so Thursday; Monday evening: Friday.
    expect(ibkrTestDay(ny("2026-09-28", "10:00"))).toBe("2026-09-24");
    expect(ibkrTestDay(ny("2026-09-28", "19:30"))).toBe("2026-09-25");
    // Weekend: Friday is the last completed day, so Thursday.
    expect(ibkrTestDay(ny("2026-10-03", "12:00"))).toBe("2026-10-01");
    expect(ibkrTestDay(ny("2026-10-04", "21:00"))).toBe("2026-10-01");
  });

  it("asks IBKR for that one day and logs the pull as a test", async () => {
    const sent: string[] = [];
    const lines: string[] = [];
    const fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("SendRequest")) {
        sent.push(`${u.searchParams.get("fd")}..${u.searchParams.get("td")}`);
        return sendOk();
      }
      return new Response(flexXml);
    }) as unknown as typeof globalThis.fetch;
    const out = await testIbkrCredentials(TOKEN, QUERY, { fetch, sleep: async () => {}, log: (l) => lines.push(l) }, ny("2026-09-30", "20:41"));
    expect(out.statementDate).toBe("2026-09-28");
    expect(sent).toEqual(["20260929..20260929"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[yomi\] IBKR Flex pull \(test\): asked 2026-09-29\.\.2026-09-29; no retries; no fallback; statement 2026-09-28; sections /);
  });

  it("gives up after about a minute with a calm try-again error", async () => {
    const slept: number[] = [];
    const lines: string[] = [];
    const fetch = (async (url: string) => (new URL(url).pathname.endsWith("SendRequest") ? sendOk() : notReady())) as unknown as typeof globalThis.fetch;
    const err = await testIbkrCredentials(TOKEN, QUERY, { fetch, sleep: async (ms) => void slept.push(ms), log: (l) => lines.push(l) }, ny("2026-09-30", "20:41")).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invest_ibkr_test_timeout", params: { flexCode: "1019" } });
    expect((err as Error).message).toMatch(/still preparing the statement/);
    // The pause before the first poll and every wait share the 60 s budget; the last wait is cut to what is left.
    expect(slept.reduce((a, b) => a + b, 0)).toBe(IBKR_TEST_MAX_WAIT_MS);
    expect(slept).toEqual([5000, 5000, 10_000, 20_000, 20_000]);
    expect(lines[0]).toContain("retries get 1019 +5 s, get 1019 +10 s, get 1019 +20 s, get 1019 +20 s");
    expect(lines[0]).toContain("failed invest_flex_in_progress_timeout (IBKR 1019)");
  });
});

describe("Flex pull log line", () => {
  it("names the kind, window, each retry with its wait, the fallback, statement date, sections and seconds", () => {
    expect(
      formatFlexPullLog({
        kind: "scheduled",
        range: { from: "2026-09-23", to: "2026-09-30" },
        retries: [
          { stage: "send", code: "1018", waitMs: 10_000 },
          { stage: "get", code: "1019", waitMs: 5000 },
        ],
        fallback: { to: "2026-09-29", code: "1003" },
        statementDate: "2026-09-29",
        sections: ["accountInformation", "openPositions", "nav"],
        error: null,
        ms: 21_449,
      }),
    ).toBe(
      "[yomi] IBKR Flex pull (scheduled): asked 2026-09-23..2026-09-30; retries send 1018 +10 s, get 1019 +5 s; fallback to 2026-09-29 after 1003; statement 2026-09-29; sections accountInformation, openPositions, nav; 21.4 s",
    );
    expect(formatFlexPullLog({ kind: "history", range: null, retries: [], fallback: null, statementDate: null, sections: null, error: { code: "invest_ibkr_token_expired", flexCode: "1012" }, ms: 800 })).toBe(
      "[yomi] IBKR Flex pull (history): asked the query's own period; no retries; no fallback; failed invest_ibkr_token_expired (IBKR 1012); 0.8 s",
    );
  });

  it("never carries the token, the query ID or an amount, also when IBKR's error message echoes them", async () => {
    const lines: string[] = [];
    let sends = 0;
    const fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("SendRequest")) {
        sends++;
        if (sends === 1) return answer("Fail", `<ErrorCode>1003</ErrorCode><ErrorMessage>Statement not available for ${TOKEN} ${QUERY}</ErrorMessage>`);
        return sendOk();
      }
      return new Response(flexXml);
    }) as unknown as typeof globalThis.fetch;
    const source = ibkrSourceFor(TOKEN, QUERY, { fetch, sleep: async () => {}, log: (l) => lines.push(l) });
    const st = await source.fetchStatement({ from: "2026-09-29", to: "2026-09-29" }, "sync");
    const expired = (async () => answer("Fail", `<ErrorCode>1012</ErrorCode><ErrorMessage>Token ${TOKEN} has expired.</ErrorMessage>`)) as unknown as typeof globalThis.fetch;
    await ibkrSourceFor(TOKEN, QUERY, { fetch: expired, log: (l) => lines.push(l) }).fetchStatement(undefined, "history").catch(() => {});

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("IBKR Flex pull (sync): asked 2026-09-29..2026-09-29; no retries; fallback to 2026-09-28 after 1003; statement 2026-09-28");
    expect(lines[1]).toContain("IBKR Flex pull (history): asked the query's own period; no retries; no fallback; failed invest_ibkr_token_expired (IBKR 1012)");
    // Decimal amounts only: a bare "100" would also match inside a code like 1003.
    const amounts = st.holdings.flatMap((h) => [h.price, h.marketValue, h.costBasis]).filter((v): v is string => typeof v === "string" && v.includes("."));
    expect(amounts.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(QUERY);
      for (const a of amounts) expect(line).not.toContain(a);
    }
  });
});
