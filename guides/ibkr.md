# Connect Interactive Brokers (Flex Web Service)

Last checked: 2026-09-30

yomi can pull your Interactive Brokers (IBKR) holdings, cash balances, trades and dividends once per trading day through IBKR's Flex Web Service. You create a saved report (an Activity Flex Query) and a read-only token in IBKR's Client Portal, give both to yomi, and the Assets page shows positions at the last close. The token can only fetch that report; yomi cannot trade or move money.

## 1. Create the Activity Flex Query

Steps follow [IBKR's Activity Flex Query guide](https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm) and the in-app guide in Settings > Connections.

1. Sign in to [Client Portal](https://www.interactivebrokers.com/portal/) and open **Performance & Reports > Flex Queries** (IBKR also lists it as Menu > Reporting > Flex Queries).
2. Create an **Activity Flex Query** (the **+** icon) and give it a name.
3. Select these sections. Selecting all fields in each is fine.

   | Section | Option | What yomi reads |
   |---------|--------|-----------------|
   | Account Information | | account currency and alias |
   | Open Positions | **Summary** | symbol, description, asset category, currency, conid, ISIN/CUSIP, multiplier, position, mark price, position value, cost basis |
   | Cash Report | | ending cash per currency (the base-currency summary row is skipped) |
   | Trades | **Execution** | trade date, buy/sell, quantity, net cash, transaction ID |
   | Cash Transactions | **Detail** | dividends, withholding tax, interest, fees, deposits and withdrawals |

   Lot-level rows (Open Positions with lots) are ignored so positions are not double counted. Other sections are not used.
4. **Delivery Configuration:** include the accounts you want, Format **XML**, Period **Last Business Day**.
5. **General Configuration:** Date Format **yyyy-MM-dd** (yyyyMMdd and MM/dd/yyyy also work).
6. Save. Note the **query ID** (digits only) shown next to the query in the Flex Queries list.

## 2. Generate the Flex Web Service token

Steps follow [IBKR's Flex Web Service guide](https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm).

1. On the same Flex Queries page, open **Flex Web Service Configuration** and turn the service on.
2. Generate a token. Under **Should Expire After**, choose a long period: the default is 6 hours, which would stop syncs the same day. Write down the expiry date.
3. Leave **Valid For IP Address** empty unless this computer has a fixed public address. A token limited to another address fails with an IP restriction error.
4. Copy the token. Treat it like a password: anyone with it and the query ID can read your report.

## 3. Enter them in yomi

**Settings:** open Settings > Connections. In the **Brokerages** card, the Interactive Brokers row has **Set up**. Paste the **Flex token** and the **Flex query ID**, optionally the **Token expires on** date, then click **Test connection**. IBKR can take up to a minute to prepare the statement; a success message names the statement date and the number of positions. You can also save without a successful test. Values are stored encrypted (see the [Plaid guide](plaid.md#security) for how the key works).

**Environment:** set these in `.env.local` at the repository root and restart `pnpm dev`. They win over Settings, field by field.

```
IBKR_FLEX_TOKEN=...
IBKR_FLEX_QUERY_ID=...
```

**Expiry reminder:** if you entered the expiry date, the row warns from 14 days before ("Token expires in N days"). To renew, generate a new token in Client Portal, then use **Replace token**. Removing the token in yomi stops pulls; the token itself stays valid at IBKR until it expires.

## How syncing works

- yomi sends a request for your query (SendRequest), receives a reference code, waits 5 seconds, then asks for the statement (GetStatement). IBKR builds statements asynchronously, so "not ready yet" answers are retried with growing pauses (5 s up to 30 s) for at most 5 minutes.
- The scheduled pull runs once per trading day after 18:00 New York time, for the statement of that day's close. It also catches up when yomi starts after being off.
- If IBKR still returns the previous day's statement, yomi stores it, shows "IBKR has not published the {date} statement yet; yomi will retry", and asks again every 2 hours overnight until 06:00 New York the next morning. IBKR usually publishes after midnight New York. If it is still not there, the day is treated as a market holiday and the normal daily schedule resumes.
- Pulls are never closer than 10 minutes apart (IBKR allows about one request per second and ten per minute per token). After a failed pull, the next try is 30 minutes later.
- **Sync now** on the Assets page pulls right away. From the terminal, `pnpm invest:sync ibkr` does the same; with the default embedded database, stop `pnpm dev` first, since a PGlite directory can be open in one process only.
- Scheduled pulls run only on the default ledger `data/pglite` (set `YOMI_BACKGROUND_SYNC=1` for another database).
- Holdings and investment activity appear on the Assets page. They are not added to your spending ledger.

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
| Positions doubled or missing | Open Positions must use **Summary**; Trades **Execution**; Cash Transactions **Detail**. Check that the right accounts are included. |

See also: [Plaid guide](plaid.md) for brokerages other than IBKR, [README](../README.md).
