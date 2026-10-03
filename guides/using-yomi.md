# Using yomi

Last checked: 2026-09-30

A tour of the everyday tasks after the first `pnpm dev`: importing statements, syncing banks, splitting costs, sending statements, quick entry and updating yomi.

## First steps

1. Open **Import** and drop a statement file (see below).
2. Open **Transactions** and tag shared rows with people (the **Split** marker on each row, or press `a`).
3. Open **Tools > Split and settle** to see what is open with each person.

## Import your statements

Open **Import** and drop one or several files. yomi detects the source, shows a preview with the statement's own totals next to what it parsed, and imports on confirm. Re-importing the same file adds only new rows, and a payment that shows up in Alipay or WeChat Pay and again on the card behind it is recorded once. Every import is a batch you can undo in **Import history**.

| Source | File | Guide |
|--------|------|-------|
| Alipay | CSV, emailed as a zip | [import-alipay.md](import-alipay.md) |
| WeChat Pay | xlsx (older exports CSV), emailed as a zip | [import-wechat.md](import-wechat.md) |
| ICBC credit card | Credit card history PDF from the ICBC app | [import-icbc.md](import-icbc.md) |
| ICBC SMS alerts | Paste into Add (⌘K) | [import-icbc.md#sms-alerts](import-icbc.md#sms-alerts) |
| Bank of America | Checking or credit card CSV | [import-boa.md](import-boa.md) |

From the terminal (same checks and dedup; stop `pnpm dev` first if it uses the same ledger):

```bash
pnpm import:files ~/Downloads/alipay.csv ~/Downloads/wechat.xlsx
```

## Connect a bank or brokerage

- **Plaid** (your own keys): get keys and enable Transactions and Investments, enter them in **Settings > Connections > Developer keys** (or `.env.local`), test, save, then click **Connect bank** or **Connect brokerage** and log in inside Plaid's window. Transactions sync at startup and every 6 hours (posted ones only); brokerage holdings once per trading day. **Sync now** works any time. See [plaid.md](plaid.md).
- **Interactive Brokers**: create an Activity Flex Query and a Flex Web Service token in IBKR's Client Portal, then enter the token and query ID in **Settings > Connections**. Holdings, recent trades and dividends appear on **Assets**. See [ibkr.md](ibkr.md).

## Split and settle

- On **Transactions**, click a row's **Split** marker (or press `a`) and tick the people who share it: equal shares, exact amounts, or "they paid". The same popover works on a selection of rows.
- **Tools > Split and settle** shows what is open per person and currency, with suggestions for transfers that look like repayments.
- **Settle up** marks items as settled; **Record a transfer or repayment** logs money that moved outside yomi.
- **Rules** can categorize and split recurring merchants automatically.

## Statements and payment details

On **Split and settle**, open **Statement** for a person: choose items, then **Copy text**, or **Print preview** to save as PDF, print or save as an image, in English or Chinese. Add your payment methods (Zelle, Venmo, PayPal, Cash App, Alipay, WeChat, other) in **Settings > Profile**; a statement lists the ones in its currency, with QR codes, while something is due.

## Quick entry

Press ⌘K (Ctrl+K) anywhere. Word order does not matter, and English and Chinese words can be mixed:

| Input | Meaning |
|-------|---------|
| `lunch 35 @Alex` / `午饭 35 @Alex` | Lunch today, I paid, split equally with Alex |
| `$12.5 uber` | A USD entry, not split |
| `yesterday groceries 120 @A @B` / `昨天 买菜 120 @A @B` | Yesterday, split equally among three |
| `@Alex paid 80 utilities` / `@Alex 付 80 电费` | Alex paid 80, split in two, so 40 is open toward Alex |
| `all @Alex delivery 12` / `全给@Alex 快递 12` | I fronted 12 and all of it is Alex's |

Dates: `today`, `yesterday`, weekday names (`mon`, `last fri`), `9/28`, `2026-09-28`, `今天`, `昨天`, `前天`, `周一`, `9月28日`. Currency: `$`, `usd`, `dollars` for USD; `¥`, `rmb`, `yuan`, `元`, `块` for CNY. Pasting an ICBC card SMS alert adds that charge.

## Analysis and assets

- **Analysis** covers a day, a week (from Monday), a month, a year or any period: spending by category, the largest items or top merchants, a few short insights, a monthly target, small payments and net worth change. Links of the form `/analysis?month=YYYY-MM` and `/transactions?month=YYYY-MM` open that month.
- **Assets** shows net worth across currencies, cash and card balances, and brokerage holdings with unrealized gains.

## Update yomi

```bash
git pull
pnpm install
pnpm dev
```

Database upgrades run on start, after an automatic `pre-migrate` backup ([Backup and restore](backup-and-restore.md)).

See also: [Configuration](configuration.md), [Troubleshooting](troubleshooting.md).
