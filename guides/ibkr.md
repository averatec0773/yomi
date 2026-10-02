# Connect Interactive Brokers (Flex Web Service)

Last checked: 2026-10-01. Sources: [Activity Flex Query guide](https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm), [Flex Web Service guide](https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm), [SendRequest API reference](https://www.interactivebrokers.com/docs/web-api/api-reference/send-request).

yomi can pull your Interactive Brokers (IBKR) holdings, cash balances, trades, dividends and daily account value once per trading day through IBKR's Flex Web Service. You create a saved report (an Activity Flex Query) and a read-only token in IBKR's Client Portal, give both to yomi, and the Assets page shows positions at the last close. The token can only fetch that report; yomi cannot trade or move money.

## 1. Create the Activity Flex Query

Steps follow [IBKR's Activity Flex Query guide](https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm) and the in-app guide in Settings > Connections.

1. Sign in to [Client Portal](https://www.interactivebrokers.com/portal/) and open **Performance & Reports > Flex Queries** (IBKR also lists it as Menu > Reporting > Flex Queries).
2. Create an **Activity Flex Query** (the **+** icon) and give it a name.
3. Select these **6 sections**: **Account Information**, **Open Positions**, **Cash Report**, **Trades**, **Cash Transactions** and **Net Asset Value (NAV) in Base**. In each one, click **Select All** and tick every option shown at the top of the section (for example Summary, Lot, Execution, Order, Detail). Leave the other sections off: IBKR has no select-all for sections, and a 365-day report with more daily sections gets slow and large.

   This is safe. yomi keeps only the level it needs and skips the rest, so extra levels are never counted twice (see `isSummary` in [map.ts](../packages/importers/src/ibkr/map.ts)). From Account Information it stores only the alias and the currency, although Select All there also puts your name, address and phone in every download (see [Privacy-minimal setup](#privacy-minimal-setup) to avoid that).

   | Section | Level yomi keeps | What yomi reads |
   |---------|------------------|-----------------|
   | Account Information | | account alias and base currency |
   | Open Positions | **Summary** rows (Lot rows skipped) | symbol, description, asset class, currency, conid, ISIN/CUSIP, multiplier, quantity, mark price, position value, cost basis |
   | Cash Report | per-currency rows (the base-currency summary row is skipped) | ending cash per currency |
   | Trades | **Execution** rows (Order and Closed Lot rows skipped) | trade date, buy/sell, quantity, net cash, transaction ID |
   | Cash Transactions | **Detail** rows (Summary rows skipped) | dividends, withholding tax, interest, fees, deposits and withdrawals |
   | Net Asset Value (NAV) in Base | one row per day | report date, currency, total (cash and stock are kept with the row) |

   **NAV in Base** gives the account's total value for every day of the window, so the Investments chart on Assets goes back up to 365 days (on the first pull or with **Pull history**) instead of starting on the first sync day. On days that also have positions, the positions win. Without the section nothing changes; the history then starts on the first sync day.
4. **Delivery Configuration:** include the accounts you want, Format **XML**. **Period** does not matter, because yomi asks for its own dates on every request (see [How syncing works](#how-syncing-works)).
5. **General Configuration:** Date Format **yyyy-MM-dd** (yyyyMMdd and MM/dd/yyyy also work).
6. Save. Note the **query ID** (digits only) shown next to the query in the Flex Queries list.

### Privacy-minimal setup

Instead of **Select All**, these fields are enough. The Account Information labels were checked in the Flex editor. The others are derived from the XML attributes yomi reads (in parentheses where the name differs), so the editor's label can differ slightly.

| Section | Option | Fields |
|---------|--------|--------|
| Account Information | | Account ID, Account Alias, Currency |
| Net Asset Value (NAV) in Base | **Exclude long and short breakout** (fewer columns) | Account ID, Currency, Report Date, Cash, Stock, Total |
| Open Positions | **Summary** | Currency, Asset Class (`assetCategory`), Symbol, Description, Conid, ISIN, CUSIP, Multiplier, Quantity (`position`), Mark Price, Position Value, Cost Basis Money |
| Cash Report | | Currency, Ending Cash |
| Trades | **Execution** | Currency, Asset Class, Symbol, Description, Conid, Multiplier, Transaction ID, Trade Date, Quantity, Net Cash, Buy/Sell |
| Cash Transactions | **Detail** | Currency, Symbol, Description, Conid, Type, Amount, Date/Time (`dateTime`), Transaction ID |

## 2. Generate the Flex Web Service token

Steps follow [IBKR's Flex Web Service guide](https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm).

1. On the same Flex Queries page, open **Flex Web Service Configuration** and turn the service on.
2. Generate a token. Under **Should Expire After**, choose a long period: the default is 6 hours, which would stop syncs the same day. Write down the expiry date.
3. Leave **Valid For IP Address** empty unless this computer has a fixed public address. A token limited to another address fails with an IP restriction error.
4. Copy the token. Treat it like a password: anyone with it and the query ID can read your report.

## 3. Enter them in yomi

**Settings:** open Settings > Connections. In the **Brokerages** card, the Interactive Brokers row has **Set up**. Paste the **Flex token** and the **Flex query ID**, optionally the **Token expires on** date, then click **Test connection**. IBKR can take up to a minute to prepare the statement; a success message names the statement date and the number of positions, and lists any of the 6 sections the statement lacks with what yomi would miss (for example, without NAV in Base the investment history starts on the first sync day; without Trades there are no buys or sells). You can also save without a successful test. Values are stored encrypted (see the [Plaid guide](plaid.md#security) for how the key works).

**Environment:** set these in `.env.local` at the repository root and restart `pnpm dev`. They win over Settings, field by field.

```
IBKR_FLEX_TOKEN=...
IBKR_FLEX_QUERY_ID=...
```

**Expiry reminder:** if you entered the expiry date, the row warns from 14 days before ("Token expires in N days"). To renew, generate a new token in Client Portal, then use **Replace token**. Removing the token in yomi stops pulls; the token itself stays valid at IBKR until it expires.

## How syncing works

- yomi sends a request for your query (SendRequest), receives a reference code, waits 5 seconds, then asks for the statement (GetStatement). IBKR builds statements asynchronously, so "not ready yet" answers are retried with growing pauses (5 s up to 30 s) for at most 5 minutes.
- yomi chooses the dates, not the query's Period: every request carries IBKR's `fd`/`td` override (from date, to date), ending on the last trading day whose close has passed (after 18:00 New York on a weekday, else the weekday before; on a weekend or a Monday before 18:00 that is Friday).
- **First pull:** the last 365 days, so trades, dividends, interest, fees, deposits and withdrawals of the past year are filled in, and with NAV in Base the daily account value of the past year. 365 days is IBKR's limit for one request; older activity cannot be pulled through the Flex Web Service.
- **Later pulls** (scheduled and **Sync now**): from a week before the last statement yomi stored up to the last trading day, at most 365 days. A yomi that was off for a while catches up on its own; the overlap re-reads late-posting activity, which is updated in place, never duplicated.
- **Pull history:** in Settings > Connections, the Interactive Brokers row's menu has **Pull history…**. Enter a number of days from 1 to 365 (default 365) to pull that much activity ending on the last trading day. It counts as a pull for the limits below, and the dialog says when it can run again if it is too soon.
- Holdings and cash are always the statement's closing values for its last day, whatever the window.
- The scheduled pull runs once per trading day after 18:00 New York time, for the statement of that day's close. It also catches up when yomi starts after being off.
- If IBKR answers that the statement for the last day is not available yet, yomi asks once more for the window ending a weekday earlier. If IBKR still returns the previous day's statement, yomi stores it, shows "IBKR has not published the {date} statement yet; yomi will retry", and asks again every 2 hours overnight until 06:00 New York the next morning. IBKR usually publishes after midnight New York. If it is still not there, the day is treated as a market holiday and the normal daily schedule resumes.
- Scheduled pulls and **Pull history** are never closer than 10 minutes apart (IBKR allows one request per second and ten per minute per token). After a failed pull, the next try is 30 minutes later.
- **Sync now** on the Assets page pulls right away. From the terminal, `pnpm invest:sync ibkr` does the same; with the default embedded database, stop `pnpm dev` first, since a PGlite directory can be open in one process only.
- Scheduled pulls run only on the default ledger `data/pglite` (set `YOMI_BACKGROUND_SYNC=1` for another database).
- Holdings and investment activity appear on the Assets page. They are not added to your spending ledger.
- The Investments chart compares the market value with **Net deposits since** the first day shown: deposits minus withdrawals (Cash Transactions), starting at that day's value, so the gap between the lines is market gain or loss. Trades and dividends show as dots on the value line.

## Troubleshooting

| Message | Cause and fix |
|---------|---------------|
| "The IBKR statement was not ready in time" | IBKR was still generating it after 5 minutes (common right after the close or at busy times). Try **Sync now** again in a few minutes; the schedule retries on its own. |
| "IBKR has not published the {date} statement yet" | Normal in the evening. yomi keeps showing the last statement and retries overnight. No action needed. |
| "The IBKR Flex token has expired" | Generate a new token under Flex Web Service Configuration, then **Replace token**. |
| "IBKR does not accept the Flex token" | Token mistyped, revoked, or the Flex Web Service was turned off. Check it and paste it again. |
| "IBKR does not know this Flex query" | Wrong query ID, or the query is not an Activity Flex Query. |
| "The Flex token only works from other IP addresses" | Clear **Valid For IP Address** or enter this computer's current public address. |
| "IBKR is limiting Flex requests" | Too many requests with this token. Wait a minute. |
| "The IBKR statement could not be read" | The query's format is not XML. Change Delivery Configuration to XML. |
| "IBKR was pulled less than 10 minutes ago" / "The last IBKR pull failed" (Pull history) | Pull history waits 10 minutes after the last pull and 30 minutes after a failed one. Try again after the minutes shown. |
| Positions doubled or missing | Open Positions must include **Summary**; Trades **Execution**; Cash Transactions **Detail** (other levels are skipped). Check that the right accounts are included. |
| Investment history starts on the first sync day | The query has no **Net Asset Value (NAV) in Base** section. Add it, then use **Pull history** to fill the past 365 days. |

See also: [Plaid guide](plaid.md) for brokerages other than IBKR, [README](../README.md).
