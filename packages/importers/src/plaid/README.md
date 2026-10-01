# Plaid

Client (`client.ts`, global `fetch`, no SDK) and a pure mapper (`map.ts`) from Plaid transactions to
`NormalizedRow` with `source: 'plaid'`. The sync logic lives in `packages/core/src/sync/` behind the
`BankProvider` interface (`plaid.ts` there).

## Verified facts (checked against plaid.com docs on 2026-09-29)

| Fact | Source |
|------|--------|
| Hosts: `https://sandbox.plaid.com`, `https://production.plaid.com`. `client_id` + `secret` go in the JSON body (or the `PLAID-CLIENT-ID` / `PLAID-SECRET` headers); `Content-Type: application/json`. Every call is a POST. | https://plaid.com/docs/api/ |
| One secret per environment (Sandbox and Production); keys are under Dashboard → Developers → Keys. Sandbox login `user_good` / `pass_good` (2FA `1234`). | https://plaid.com/docs/quickstart/, https://plaid.com/docs/sandbox/ |
| Trial plan: US/Canada teams created on or after 2026-04-15; free; **Production environment** with real data; 10 Production Items total (removing an Item does not free a slot); Transactions included; unlimited calls on existing Items. Compliance requirements (and the Security Questionnaire needed for Chase / PNC) are waived until a paid upgrade; most OAuth banks incl. Bank of America are available. | https://plaid.com/docs/account/billing/, https://plaid.com/docs/link/oauth/ |
| `/link/token/create` requires `client_name` (max 30 chars), `language`, `country_codes`, `user.client_user_id`, `products` (not in update mode). Update mode: pass `access_token`, omit `products`. `transactions.days_requested` 1 to 730, default 90 (only at Item creation). Returns `link_token`, `expiration` (4 h new, 30 min update). | https://plaid.com/docs/api/link/, https://plaid.com/docs/api/products/transactions/ |
| OAuth on desktop web works without `redirect_uri`: Link opens the bank in a popup. `redirect_uri` is needed only in mobile webviews / native apps. (The API reference text says it is required for OAuth; the OAuth guide is more specific and says desktop web works without it.) | https://plaid.com/docs/link/oauth/ |
| Link web: `<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js">`, must be loaded from the CDN (no bundling or self-hosting). `Plaid.create({ token, onSuccess(public_token, metadata), onExit(err, metadata), onEvent })`, `handler.open()`, `handler.destroy()`. `metadata.institution {name, institution_id}`, `metadata.accounts [{id, name, mask, type, subtype}]`. | https://plaid.com/docs/link/web/ |
| `/item/public_token/exchange` (`public_token`, valid 30 min) → `access_token`, `item_id`. Tokens are `[type]-[environment]-[uuid]`, e.g. `access-sandbox-…`. | https://plaid.com/docs/api/items/, https://plaid.com/docs/quickstart/glossary/ |
| `/accounts/get` → `accounts [{account_id, name, official_name, mask, type (depository/credit/loan/investment/other), subtype, balances {iso_currency_code, unofficial_currency_code}}]`, `item {item_id, institution_id, institution_name}`. | https://plaid.com/docs/api/accounts/ |
| `/transactions/sync` (`access_token`, `cursor`, `count` ≤ 500): `added`, `modified`, `removed [{transaction_id, account_id}]`, `accounts`, `next_cursor`, `has_more`, `transactions_update_status`. One cursor per Item. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restart the whole loop from the first cursor. While data is not ready, arrays are empty and `next_cursor` is `""`. | https://plaid.com/docs/api/products/transactions/ |
| **Sign:** `amount` is a JSON number, "positive values when money moves out of the account; negative values when money moves in", for every account type: card purchases positive, card payments and deposits negative. Stored rows negate it (negative = money leaving me). | https://plaid.com/docs/api/products/transactions/ |
| Transaction fields used: `transaction_id, account_id, amount, iso_currency_code, unofficial_currency_code, date, authorized_date, pending, pending_transaction_id, merchant_name, name, personal_finance_category {primary, detailed}`. A pending row that posts arrives as a new `transaction_id` with `pending_transaction_id`, and the pending one is removed. | https://plaid.com/docs/api/products/transactions/ |
| `personal_finance_category`: teams enabled after 2025-12-03 get PFCv2 by default. Primaries: INCOME, LOAN_DISBURSEMENTS, LOAN_PAYMENTS, TRANSFER_IN, TRANSFER_OUT, BANK_FEES, ENTERTAINMENT, FOOD_AND_DRINK, GENERAL_MERCHANDISE, HOME_IMPROVEMENT, MEDICAL, PERSONAL_CARE, GENERAL_SERVICES, GOVERNMENT_AND_NON_PROFIT, TRANSPORTATION, TRAVEL, RENT_AND_UTILITIES, OTHER. Details used: `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`, `FOOD_AND_DRINK_GROCERIES`, `INCOME_SALARY`, `TRANSFER_IN_TRANSFER_IN_FROM_APPS`, `TRANSFER_OUT_TRANSFER_OUT_FROM_APPS`. | https://plaid.com/docs/transactions/pfc-migration/, https://plaid.com/documents/pfc-taxonomy-all.csv |
| `/item/remove` invalidates the access token and is required to end Transactions subscription billing. | https://plaid.com/docs/api/items/ |
| Errors: JSON `{error_type, error_code, error_message, display_message, request_id}` with a non-2xx status. Update mode fixes `ITEM_LOGIN_REQUIRED`, `INVALID_CREDENTIALS`, `PASSWORD_RESET_REQUIRED`, `MFA_NOT_SUPPORTED`. Gone Items: `ITEM_NOT_FOUND`, `INVALID_ACCESS_TOKEN` (type `INVALID_INPUT`). `RATE_LIMIT_EXCEEDED`, `INSTITUTION_NOT_RESPONDING`. | https://plaid.com/docs/errors/ |
| Bank of America: OAuth. BoA refuses apps with an empty company profile (Dashboard compliance center, Company Profile / application display information). Throughout 2026 old-API Items migrate through update mode (`PENDING_DISCONNECT` webhook, then `ITEM_LOGIN_REQUIRED` a week later). New-API Items have a 12-month consent expiry and BoA shows its own account-select screen. | https://plaid.com/docs/link/oauth/ |

## Link sessions and lost Items (checked 2026-09-29)

Incident: in Production the bank login finished (onExit `status: connected`, so Plaid created an
Item and used a Trial slot) but Link was closed on its last pane ("Share data"), onSuccess never
fired and the public token never reached yomi. What the docs say and what Sandbox showed:

| Fact | Source |
|------|--------|
| `/link/token/get` (`link_token`) returns `link_sessions[]`: `link_session_id`, `started_at`, `finished_at`, `on_success`, `on_exit` / `exit`, `events`, and `results.item_add_results[] {public_token, accounts, institution}`. "Session data will be provided for up to six hours after the session has ended." | https://plaid.com/docs/api/link/#linktokenget |
| The docs present it for flows "that don't provide a public token via frontend callbacks, such as the Hosted Link flow and the Multi-Item Link flow". They do not say standard Link is excluded. | https://plaid.com/docs/api/link/#linktokenget |
| Multi-Item Link (`enable_multi_item_link: true`) needs `/user/create` first and a `user_id` / `user_token`; its frontend onSuccess is **empty**, public tokens come only from `SESSION_FINISHED` / `ITEM_ADD_RESULT` webhooks or `/link/token/get` (6 h after the session). | https://plaid.com/docs/link/multi-item-link/, https://plaid.com/docs/api/link/ |
| Hosted Link (`hosted_link: {}`) delivers tokens the same way (webhooks, or `/link/token/get` as the backup); works in Sandbox. | https://plaid.com/docs/link/hosted-link/ |
| Webhooks `ITEM_ADD_RESULT` ("An Item was added during a Link session") and `SESSION_FINISHED` need a public URL; yomi has none, so it polls `/link/token/get`. | https://plaid.com/docs/api/link/ |
| Link tokens live 4 h (new login) / 30 min (update mode). Public tokens live 30 minutes. | https://plaid.com/docs/api/link/, https://plaid.com/docs/api/items/ |
| **Observed in Sandbox with standard Link (no multi-item, no hosted link, no webhook):** `results.item_add_results[0].public_token` is present as soon as the OAuth bank login returns, while Link still shows "Share data" and `finished_at` is absent. After Exit on that pane: `finished_at` set, `exit.metadata.status: "connected"`, the same `item_add_results`. After a normal "Share data": `finished_at` set, `item_add_results` filled, no `on_success` key. After a page reload: `item_add_results` filled, never finished. Exchanging a public token that recovery already exchanged (onSuccess arriving later) also succeeds and returns the same Item. | yomi e2e/plaid-sandbox.spec.ts run 2026-09-29 (Platypus OAuth Bank, user_good) |
| Right after a new Item, `/transactions/sync` may return nothing (empty arrays, `next_cursor: ""`) or only the first days; the rest arrives later. | same run; https://plaid.com/docs/api/products/transactions/ |

**Decision:** stay on standard Link. It keeps onSuccess (Multi-Item Link would remove it and needs
`/user/create`, an extra Plaid object on the Trial plan) and, as observed, `/link/token/get` already
lists the Item before the last pane. Every link token is stored in `plaid_link_sessions` at creation;
`recoverLinkSessions` (packages/core/src/sync/link-sessions.ts) polls `/link/token/get` and exchanges
any public token not exchanged yet: on Link exit (every status), after onSuccess, on /import mount, and
on every 10-minute scheduler tick, since the public token dies after 30 minutes. Items are deduped by
`item_id` (`bank_connections.enrollment_id`, unique). Update-mode sessions never create connections.
Open sessions older than 10 h (4 h token + 6 h data window) are marked expired without a call.

## Decided here

- **Amount** `Math.round(amount * 100)` once, then negated (`plaidAmountToMinor`). Exact for any
  value with at most 2 decimals under 2^53 / 100; every US currency Plaid returns has 2.
- **Time** Plaid gives dates only. Rows are stored as `<authorized_date ?? date>T12:00:00-05:00`
  (noon US Eastern standard time) so the day is the same in every US zone and in UTC.
- **Kinds** `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` and `TRANSFER_IN` / `TRANSFER_OUT` are `transfer`,
  except `*_FROM_APPS` (Zelle, Venmo, Cash App): friends paying me back must stay income / expense
  for the split screen. `INCOME` money in is `income`. Other money in is `refund` on a card (or on a
  bank account when a merchant is named or the text says refund), else `income`. The rest is `expense`.
- **Pending** rows are skipped; the posted row comes later under its own id.
- **Webhooks** are not used (local app, no public URL): the 6-hourly job and "sync now" (立即同步) pull
  `/transactions/sync`; `ITEM_LOGIN_REQUIRED` surfaces as a connection error with "reconnect" (重新连接).
- **History** new Items request `days_requested: 730` (the maximum).

## Investments (checked 2026-09-29)

| Fact | Source |
|------|--------|
| Link: put `"investments"` in `products` of `/link/token/create`. For custom Sandbox data it must be in `products`, not the optional arrays. Robinhood Items behave like Data Transparency Messaging: "no additional products may be added to the Item after Item creation unless user consent was captured", so a brokerage login asks for `investments` from the start. Schwab allows one active OAuth Item per end user per app and may need up to 5 business days after Production approval. | https://plaid.com/docs/investments/, https://plaid.com/docs/link/oauth/ |
| `/investments/holdings/get` (`access_token`, `options.account_ids`) → `accounts`, `holdings [{account_id, security_id, institution_price, institution_price_as_of, institution_value, cost_basis, quantity, iso_currency_code, unofficial_currency_code, vested_quantity, tax_lots}]`, `securities`, `item`. `cost_basis` is "the total cost basis of the holding (e.g., the total amount spent to acquire all assets currently in the holding)", nullable. Quantities, prices and values are JSON doubles; quantities are fractional (docs sample `-47.74104242992852`). | https://plaid.com/docs/api/products/investments/ |
| Securities: `security_id, isin, cusip, ticker_symbol, name, type (cash, cryptocurrency, derivative, equity, etf, fixed income, loan, mutual fund, other), subtype, is_cash_equivalent, close_price, iso_currency_code, option_contract`. Cash appears as a security with `type: "cash"`, `ticker_symbol: "USD"` in the docs sample (some institutions send `CUR:USD`); money market funds are also type `cash` with a fund ticker. | same |
| `/investments/transactions/get` (`start_date`, `end_date` required; `options.count` max 500, default 100; `options.offset`) → `investment_transactions [{investment_transaction_id, account_id, security_id, date, name, quantity, amount, price, fees, type, subtype, iso_currency_code}]`, `total_investment_transactions`, `securities`. `amount`: "Positive values when cash is debited, e.g. purchases of stock; negative values when cash is credited". `type`: buy, sell, cancel, cash, fee, transfer; subtypes include dividend, interest, tax withheld, deposit, withdrawal. Up to 24 months of history. No webhook for the initial load (`PRODUCT_NOT_READY` until ready, unless `async_update`). | same |
| Plaid refreshes investments at least once per market day (2 to 4 times at some institutions), mostly overnight after the close. `/investments/refresh` is a paid add-on. Sandbox needs no extra permissions; Sandbox Studio / the sample Investments custom user give brokerage data. | https://plaid.com/docs/investments/ |

**Decided:** a brokerage login is a `bank_connections` row with `kind = 'brokerage'`, created from a
Link session opened with `purpose: 'brokerage'` (`plaid_link_sessions.kind`, so a recovered Item gets
the right kind). It reuses Link session storage, recovery and encrypted token storage unchanged, never
maps ledger accounts and never runs `/transactions/sync` (`syncConnection` refuses it with
`connection_is_brokerage`). Holdings go to `holding_snapshots` via core `syncHoldings`; the connection's
`cursor` holds the last pull's end date (transactions window re-reads 30 days; first pull 730 days).
Doubles become decimal strings with `numberToDecimal` (shortest round-trip text), so fractional shares
are kept as sent; minor units come from the decimal string with one rounding. Cash holdings (type cash
with a currency ticker) are stored as cash rows; money market funds stay securities.

## Storage

The access token is stored in `bank_connections.access_token` in the ledger database (PGlite under
`data/pglite` by default, gitignored), sealed with AES-256-GCM (`enc:v1:...`) whenever a master key exists
(`YOMI_SECRET_KEY`, or the key file `~/.config/yomi/secret.key` that saving a secret in Settings creates);
without a key it is plaintext and the UI shows a notice. The sync cursor is in `bank_connections.cursor`.
`PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX`, `PLAID_SECRET_PRODUCTION` and `PLAID_ENV` come from the
environment (`.env.local`) or from Settings > Connections > Developer keys; the environment wins. Each
connection's environment is read from its token prefix, and sync uses that environment's secret.
Disconnecting calls `/item/remove` and blanks the stored token.
