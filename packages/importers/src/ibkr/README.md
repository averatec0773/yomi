# IBKR Flex Web Service

Client (`client.ts`, built-in fetch) and a pure mapper (`map.ts`) from an Activity Flex Query to the
normalized `InvestStatement` (`../invest.ts`). Storage, scheduling and FX live in
`packages/core/src/invest/`. Read only: holdings, cash and activity; nothing here can trade.

## Verified facts (checked 2026-09-29)

| Fact | Source |
|------|--------|
| v3 endpoints: `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=TOKEN&q=QUERY_ID&v=3` and `.../FlexWebService/GetStatement?t=TOKEN&q=REFERENCE_CODE&v=3`. Optional `fd`/`td` (yyyymmdd) or `p` (period) overrides on SendRequest. Older docs still show `https://www.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest`; the Admin Portal guide gives the `ndcdyn` URLs. | https://www.ibkrguides.com/adminportal/performanceandstatements/flex3.htm, https://www.ibkrguides.com/complianceportal/complianceportal/flexwebserviceversion3.htm |
| SendRequest answers `<FlexStatementResponse timestamp="…"><Status>Success</Status><ReferenceCode>…</ReferenceCode><Url>…GetStatement</Url></FlexStatementResponse>`; failures carry `<Status>Fail</Status><ErrorCode>…</ErrorCode><ErrorMessage>…</ErrorMessage>`. GetStatement answers the same failure shape, or the statement itself (`<FlexQueryResponse>`). The widely used ibflex client polls a `gdcdyn` host for GetStatement, so the `Url` returned is followed (IBKR hosts only). | same; https://github.com/csingley/ibflex/blob/master/ibflex/client.py |
| "Programmatic access requires the User-Agent HTTP header to be set. Accepted values are: Blackberry or Java." yomi sends `Java`. | https://www.ibkrguides.com/complianceportal/complianceportal/flexwebserviceversion3.htm |
| SendRequest overrides (checked 2026-10-01): `fd` "Short for fromDate. Define the earliest date to retrieve. If fd is used, the td parameter is required"; `td` "Short for toDate. Define the final date to retrieve. If td is used, the fd parameter is required"; `p` integer 1-365, "Number of days from the current date to retrieve data for. A maximum of 365 days may be requested." The portal guide shows them as alternative URLs: "From Date / to Date Override (yyyymmdd- up to 365 days)" (`&fd=yyyymmdd&td=yyyymmdd`) and "Period Override (up to 365 days)" (`&p=5`). Not documented: whether `td` is inclusive, the error for a range over 365 days or for a `td` whose statement is not published yet, and what happens when `p` and `fd`/`td` are combined. | https://www.interactivebrokers.com/docs/web-api/api-reference/send-request, https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm |
| Error codes: 1001 could not be generated, 1003 not available, 1004 incomplete, 1005 settlement data not ready, 1006 FIFO P/L not ready, 1007 MTM P/L not ready, 1008 MTM and FIFO not ready, 1009 server under heavy load, 1010 legacy queries unsupported, 1011 service account inactive, **1012 token has expired**, 1013 IP restriction, 1014 query is invalid, 1015 token is invalid, 1016 account invalid, 1017 reference code invalid, **1018 too many requests** ("one request per second, 10 requests per minute (per token)"), **1019 statement generation in progress**, 1020 invalid request, 1021 could not be retrieved. | https://www.ibkrguides.com/clientportal/flex3.htm |
| Token: generated under Performance & Reports > Flex Queries > Flex Web Service Configuration; "Should Expire After" list (default 6 hours; longer choices exist in the list, not enumerated in the text); optional "Valid For IP Address". | https://www.ibkrguides.com/adminportal/performanceandstatements/flex3.htm |
| Activity Flex XML is attribute-only: `FlexQueryResponse > FlexStatements > FlexStatement(accountId, fromDate, toDate, whenGenerated)` containing `AccountInformation(currency, acctAlias)`, `OpenPositions > OpenPosition`, `CashReport > CashReportCurrency`, `Trades > Trade`, `CashTransactions > CashTransaction`, `ChangeInDividendAccruals > ChangeInDividendAccrual`. | https://github.com/csingley/ibflex (Types.py, tests/test_types.py) |
| `OpenPosition`: `accountId, currency, fxRateToBase, assetCategory (STK, OPT, FUT, CASH, BOND, …), symbol, description, conid, isin, cusip, multiplier, position, markPrice, positionValue, costBasisPrice, costBasisMoney, fifoPnlUnrealized, reportDate, side, levelOfDetail (SUMMARY or LOT)`. `positionValue` is position × markPrice × multiplier; short positions have negative `position`, `positionValue` and `costBasisMoney`. | same |
| `CashReportCurrency`: `currency` (plus a `BASE_SUMMARY` roll-up row), `startingCash`, `endingCash`, and many MTD/YTD columns. | same |
| `Trade`: `tradeID, transactionID, tradeDate, quantity, tradePrice, proceeds, ibCommission, netCash, buySell (BUY, SELL, "BUY (Ca.)", "SELL (Ca.)"), levelOfDetail (EXECUTION, ORDER, CLOSED_LOT)`. `CashTransaction.type`: Deposits & Withdrawals, Broker Interest Paid/Received, Withholding Tax, Bond Interest, Other Fees, Dividends, Payment In Lieu Of Dividends, Commission Adjustments, Advisor Fees. | same (enums.py) |
| "Net Asset Value (NAV) in Base" (checked 2026-10-01): XML `EquitySummaryInBase > EquitySummaryByReportDateInBase(accountId, acctAlias, model, currency, reportDate, cash, stock, options, …, total)`, one row per report date, decimals as strings; `cash`/`stock`/`total` may carry `…Long`/`…Short` variants unless "Exclude long and short breakout" is ticked. Older output (ibflex's 2011 test row) has no `currency`. The Activity Statement reference describes the section as NAV per asset class converted to the base currency. | https://github.com/csingley/ibflex/blob/master/ibflex/Types.py (class `EquitySummaryByReportDateInBase`, "Wrapped in <EquitySummaryInBase>"), tests/test_types.py; https://www.ibkrguides.com/reportingreference/reportguide/netassetvalueinbasecurrency.htm |
| Dates follow the query's date format setting (`2026-09-28`, `20260928`, `09/28/2026`); date-times use `;` (`2026-09-28;160000`). | same; mapper accepts all three |

## Decided here

- **Polling** SendRequest, pause 5 s, then GetStatement; codes 1001/1004 to 1009/1019/1021 retry with
  a doubling delay from 5 s up to 30 s, 1018 waits at least 10 s; total wait capped at 5 minutes, then
  `in_progress_timeout` (API code `invest_flex_in_progress_timeout`). 1012 → `invest_ibkr_token_expired`,
  1015/1011 → `invest_ibkr_token_invalid`, 1013 → `invest_ibkr_ip_restricted`, 1014/1010 →
  `invest_ibkr_query_invalid`. Errors never include the token.
- **XML parser** A 100-line reader (`../util/xml.ts`) instead of `fast-xml-parser`: Flex output is flat,
  attribute-only XML; the reader rejects DOCTYPE and unknown entities (no entity-expansion surface) and
  adds no dependency.
- **Rows used** OpenPosition `levelOfDetail` SUMMARY (or absent); LOT rows would double count.
  CashReport per-currency `endingCash` as cash holdings; `BASE_SUMMARY` skipped. Trade EXECUTION rows
  (`netCash`, cash-in positive, as `trade:<transactionID>`). CashTransaction DETAIL rows
  (`cash:<transactionID>`). ChangeInDividendAccruals are accruals, not cash, and are not stored.
  NAV in Base: one `total` per `reportDate` per account (`navs`), currency from the row else the account's
  base currency; rows of another account id (a consolidated "-" row) are skipped, a repeated day keeps the
  last row. Core stores them in `investment_daily_nav` (upsert per account and day) and uses them on days
  without holding snapshots.
- **Sections present** `statement.sections` lists which of the six sections yomi reads appear as elements
  (`FLEX_SECTIONS`, empty ones included); Test connection reports the missing ones.
- **Period override** `fetchStatement(range)` sends `p` for `{ days }` or `fd`/`td` for `{ from, to }`
  (YYYY-MM-DD in, yyyymmdd out), never both. Where the docs are silent yomi is conservative: both ends count as
  inclusive, so a span may cover at most 365 calendar days; days must be a whole number 1 to 365; invalid input
  throws `range_invalid` (`invest_ibkr_range_invalid`) before anything is sent. Core always uses `from`/`to`
  ending on the last completed trading day (`ibkrWindow`), and on 1003/1020 for a `from`/`to` pull asks once
  more with `to` one weekday earlier (`ibkrSourceFor`), which then reads as a stale statement.
- **Snapshot date** the latest `FlexStatement toDate`. Values are the exact decimal strings; core turns
  `positionValue` / `costBasisMoney` / `endingCash` into minor units with one rounding each.
- **Config** `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID` from the process env, else the token and query id
  saved per user in Settings > Connections (encrypted, resolved at use time by core `resolveIbkrSource`). The
  query should be an Activity Flex Query with six sections, each with Select All and every option ticked
  (the mapper keeps only the levels it needs): Account Information, Open Positions, Cash Report, Trades, Cash
  Transactions and Net Asset Value (NAV) in Base, format XML. guides/ibkr.md lists a privacy-minimal field set.
  Any period works because yomi overrides it. The in-app guide
  links https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm (query) and
  .../flex3.htm (token: Performance & Reports > Flex Queries > Flex Web Service Configuration, "Should Expire
  After", default 6 hours), checked 2026-09-30.

## FX (Frankfurter, checked 2026-09-29)

| Fact | Source |
|------|--------|
| Public API `https://api.frankfurter.dev`, no key, "no quotas"; rate-limited against abuse. Current version: `GET /v2/rates?base=USD&quotes=CNY,HKD` → `[{"date":"2026-09-29","base":"USD","quote":"CNY","rate":6.7036}, …]`. | https://frankfurter.dev/ and a live call |
| `GET /v1/latest?base=USD&symbols=CNY,HKD` still answers (`{"amount":1.0,"base":"USD","date":…,"rates":{…}}`) but with a `Deprecation` header and `Link: <https://api.frankfurter.dev/v2/rates>; rel="successor-version"`, so yomi uses v2. | live call, response headers |
