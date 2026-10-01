# Import a Bank of America CSV

Bank of America lets you download account activity as a CSV file. yomi reads checking and savings downloads (with their balance summary) and credit card downloads, sorts each row into spending, income, refunds and transfers (Zelle payments stay income or spending so they show up when settling with friends), and adds them to your ledger in USD. If you also sync the same accounts through [Plaid](plaid.md), the CSV rows and the synced rows are linked so each transaction counts once.

## Get the file

Use Online Banking on a computer. Bank of America's FAQ describes downloading transactions only in Online Banking; in the Mobile Banking app it describes downloading statements (PDF), which yomi does not read.

1. Sign in to Online Banking at bankofamerica.com and open the account (checking, savings or credit card), then **See All Transactions** if the activity list is shortened.
2. In the **Activity** section, select **Download** on the right.
3. Choose the **Transaction Period** and the **Microsoft Excel Format**, which produces a `.csv` file, then select **Download Transactions**. For credit cards, Bank of America states that up to 12 months of transactions are available.
4. Save the file without opening and re-saving it in a spreadsheet app.

Since 2025-09-30, Bank of America no longer offers Quicken (QFX) downloads; users report that the remaining choices are the Excel (CSV) and printable text formats. Only the CSV works with yomi.

Sources:

- Bank of America, Credit Card Payments and Statements FAQ, undated: <https://www.bankofamerica.com/credit-cards/credit-card-payments-statements-faq/>. Online Banking lets you request up to 12 months of detailed transaction information and download transactions; the app offers statement downloads.
- Finaloop Help Center, "Bank of America: How to upload your CSV & bank statements", updated 2024-11-12: <https://help.finaloop.com/en/articles/9306344-bank-of-america-how-to-upload-your-csv-bank-statements>. See All Transactions → Activity → Download → Transaction Period → Microsoft Excel Format → Download Transactions, for checking and credit card accounts.
- Quicken Community announcement, "9/30/25 Bank of America - OFX Discontinued", 2025-09-30: <https://community.quicken.com/discussion/7966609/9-30-25-bank-of-america-ofx-discontinued>. QFX (Web Connect) downloads ended. A user thread from 2026-01-03 reports only "Microsoft Excel Format" and "Printable Text Format" remain: <https://community.quicken.com/discussion/7969708/can-039-t-download-bank-of-america-data-in-qfx-format>.

The download path comes from a third-party help center; Bank of America's own pages confirm the feature but do not list the clicks.

Last checked: 2026-10-01

## What yomi expects

yomi recognizes a Bank of America CSV by its first non-blank line, whatever the file name, as long as it ends in `.csv`.

| Item | Checking or savings | Credit card |
|------|---------------------|-------------|
| First line | `Description,,Summary Amt.` (summary block) or `Date,Description,Amount,Running Bal.` | `Posted Date,Reference Number,Payee,Address,Amount` |
| Summary read | `Beginning balance as of MM/DD/YYYY`, `Total credits`, `Total debits`, `Ending balance as of MM/DD/YYYY` | None |
| Columns used | `Date`, `Description`, `Amount`, `Running Bal.` | `Posted Date`, `Reference Number`, `Payee`, `Address`, `Amount` |
| Dates | `MM/DD/YYYY` | `MM/DD/YYYY` |
| Amount sign | Negative is money out | Charges negative, payments and credits positive (inferred from real files, not documented by the bank) |

- Encoding: UTF-8; a byte order mark is fine.
- Currency: USD for every row.
- Time zone: the bank gives dates only. yomi keeps the calendar day as written, whatever time zone you set in Settings.
- The first checking row (`Beginning balance as of …`, no amount) is skipped.

How descriptions are read (checking): card purchases are spending (positive ones are refunds); `Zelle payment to|from NAME` is spending or income with NAME as the counterparty; wires are income or spending; payroll is income; card payments, online banking transfers and ATM withdrawals are transfers; fees, interest, deposits and rewards get their own category. On the card file, a positive row with `PAYMENT` in the payee is a card payment (transfer); other positive rows are refunds.

## What yomi does with it

1. **Reconciliation.** For checking and savings, yomi compares the sum of credits and of debits with `Total credits` and `Total debits`, and checks that beginning balance plus all amounts equals the ending balance. The credit card file states no totals, so the preview shows "Not stated" and there is nothing to compare.
2. **Backup.** The ledger is backed up to `data/backups/` before the import.
3. **Dedup.** Card rows are keyed by `Reference Number`. Checking rows are keyed by date, amount, running balance and description, so two downloads with overlapping date ranges only add the rows that are new, and two identical same-day purchases are both kept. Importing the exact same file again is refused with "This file was already imported"; importing anyway only adds rows not seen before.
4. **Accounts.** The CSV carries no account number. Checking and savings rows go into one account named `Bank of America 支票` (checking), card rows into `Bank of America 信用卡` (credit card).
5. **Linking with Plaid.** When the same Bank of America transaction also arrives through bank sync, the later row is linked to the earlier one (same kind of account, amount and currency, within 3 days). The earlier row keeps its splits and edits. The two ledger accounts stay separate. CSV rows have no card number, so they are not linked to Alipay or WeChat rows.
6. **Undo.** Each import is a batch under **Import history** on the Import page. **Revert** deletes the batch's transactions you have not edited and lets you import the file again.

## Import it

**Web:** open the Import page and drop the file on the drop zone, or choose it. Several files at once are fine. Check the preview, then **Import**. When totals do not match, tick "I have checked, import anyway" first.

**Terminal:**

```bash
pnpm import:files ~/Downloads/stmt.csv ~/Downloads/card-activity.csv
```

`--force` imports a file seen before. With the default embedded database, stop `pnpm dev` first (a PGlite directory can be open in one process only; the command refuses while the server holds it). The terminal import does not stop on a mismatch; it prints "does NOT reconcile".

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| Read as an Alipay file, "header row (交易时间) was not found" | The first line is not one of the Bank of America headers above, often because the file was edited or re-saved. Download it again. |
| "Balances do not add up" | Rows are missing from the download, or the file was edited. Download the full range again. |
| "a payment is negative, the sign convention may be reversed" | The card file's signs are not as expected. Check a few rows against the bank's website before importing; please report it without sharing real data. |
| Checking and savings mixed in one account | Both downloads look the same and carry no account number. Import only one of them, or use [bank sync](plaid.md), which keeps accounts apart. |
| A transaction counted twice with bank sync | The two rows are more than 3 days apart or have different amounts. Fix one of them by hand. |

See also: [Plaid guide](plaid.md), [README](../README.md).
