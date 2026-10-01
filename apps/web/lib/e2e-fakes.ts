import "server-only";
/**
 * YOMI_E2E=1 only (see app/api/[[...route]]/route.ts): a stand-in for the IBKR Flex Web Service at the fetch
 * boundary, so e2e runs the real client (SendRequest, GetStatement, parsing) without calling IBKR. It accepts
 * the fictional token `test-token-3141` with query `123456` and answers anything else with IBKR's
 * "token is invalid" (1015). The statement repeats the demo ledger's latest IBKR statement (2026-09-28, same
 * values), so a Sync now in e2e rewrites it in place and later specs see the same numbers.
 */
export const E2E_FLEX_TOKEN = "test-token-3141";
export const E2E_FLEX_QUERY = "123456";
const REFERENCE = "3141592653";

function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { headers: { "Content-Type": "text/xml" } });
}

function fail(code: string, message: string): Response {
  return xml(`<FlexStatementResponse timestamp="30 September, 2026 12:00 PM EDT"><Status>Fail</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${message}</ErrorMessage></FlexStatementResponse>`);
}

function statement(day: string): string {
  const d = day.replaceAll("-", "");
  const pos = (symbol: string, desc: string, conid: string, currency: string, qty: string, price: string, value: string, cost: string) =>
    `<OpenPosition accountId="U0000001" currency="${currency}" assetCategory="STK" symbol="${symbol}" description="${desc}" conid="${conid}" multiplier="1" reportDate="${day}" position="${qty}" markPrice="${price}" positionValue="${value}" costBasisMoney="${cost}" side="Long" levelOfDetail="SUMMARY" />`;
  return `<FlexQueryResponse queryName="yomi holdings" type="AF"><FlexStatements count="1">
<FlexStatement accountId="U0000001" fromDate="${day}" toDate="${day}" period="LastBusinessDay" whenGenerated="${d};203015">
<AccountInformation accountId="U0000001" acctAlias="IBKR U0000001" currency="USD" />
<CashReport><CashReportCurrency accountId="U0000001" currency="USD" levelOfDetail="Currency" endingCash="1234.56" /><CashReportCurrency accountId="U0000001" currency="HKD" levelOfDetail="Currency" endingCash="500" /></CashReport>
<OpenPositions>
${pos("AAPL", "APPLE INC", "265598", "USD", "25", "229.87", "5746.75", "4380.50")}
${pos("VTI", "VANGUARD TOTAL STOCK MKT ETF", "12345001", "USD", "40", "301.12", "12044.80", "10212.40")}
${pos("700", "TENCENT HOLDINGS LTD", "12345002", "HKD", "100", "512.5", "51250", "38420")}
</OpenPositions>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
}

export const e2eFlexFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!url.hostname.endsWith("interactivebrokers.com")) throw new Error(`e2e Flex fake: unexpected host ${url.hostname}`);
  const t = url.searchParams.get("t");
  const q = url.searchParams.get("q");
  if (t !== E2E_FLEX_TOKEN) return fail("1015", "Token is invalid.");
  if (url.pathname.endsWith("/SendRequest")) {
    if (q !== E2E_FLEX_QUERY) return fail("1014", "Query is invalid.");
    return xml(
      `<FlexStatementResponse timestamp="30 September, 2026 12:00 PM EDT"><Status>Success</Status><ReferenceCode>${REFERENCE}</ReferenceCode><Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>`,
    );
  }
  if (url.pathname.endsWith("/GetStatement") && q === REFERENCE) return xml(statement("2026-09-28"));
  return fail("1017", "Reference code is invalid.");
};

/**
 * YOMI_E2E=1 only: Plaid's /institutions/get for "Test keys". Accepts the client id `test-client-3141` with the
 * secret `test-secret-3141` in either environment and answers anything else with INVALID_API_KEYS, like Plaid.
 */
export const E2E_PLAID_CLIENT_ID = "test-client-3141";
export const E2E_PLAID_SECRET = "test-secret-3141";

export const e2ePlaidFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!url.hostname.endsWith("plaid.com") || url.pathname !== "/institutions/get") throw new Error(`e2e Plaid fake: unexpected ${url.href}`);
  const body = JSON.parse(String(init?.body ?? "{}")) as { client_id?: string; secret?: string };
  if (body.client_id === E2E_PLAID_CLIENT_ID && body.secret === E2E_PLAID_SECRET) {
    return Response.json({ institutions: [{ institution_id: "ins_109508", name: "First Platypus Bank" }], total: 1, request_id: "e2e" });
  }
  return Response.json(
    { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS", error_message: "invalid client_id or secret provided", display_message: null, request_id: "e2e" },
    { status: 400 },
  );
};
