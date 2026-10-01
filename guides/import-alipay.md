# Import an Alipay statement

Alipay (支付宝) lets you export every transaction of a period as a CSV file. yomi reads that file on your computer, checks it against the totals Alipay prints at the top, and adds each payment, transfer and refund to your ledger. A purchase paid with a bank card through Alipay is linked to the same charge on the card statement, so it counts once.

## Get the file

1. In the Alipay app, open **Me → Bills** (我的 → 账单), tap **···** at the top right, then **Issue transaction statement** (开具交易流水证明).
2. Choose **For personal reconciliation** (用于个人对账); the proof purpose produces a stamped PDF that yomi does not read. Confirm with your payment password, fingerprint or face.
3. Pick the transaction type (all) and the period, then enter the email address that should receive the file (for example `alex@example.com`). One request covers at most one year, so export longer histories year by year.
4. Alipay emails a `.zip` archive. The unzip password is shown in the Alipay app: in the notification Alipay sends after the export, or in the request's record (开具记录).
5. Unzip it. Keep the `.csv` inside exactly as it is: do not open and re-save it in Excel or Numbers.

Alipay's own help pages only describe an older desktop flow (收支明细证明 on alipay.com), so the app steps above come from recent third-party guides. If the menu has moved, search the app for "交易流水" (transaction statement).

Sources:

- Hessel, "新的一年，不妨试试自己分析支付宝账单" (analyze your own Alipay bills), Sspai (少数派), 2025-02-23: <https://sspai.com/post/96151>. Bills → top right → 开具交易流水证明 → 用于个人对账, up to one year per request, CSV by email, unzip password in the request's record.
- "2025微信/支付宝/银行开具交易流水证明指南", Extrabux, 2025-07-09: <https://www.extrabux.com/chs/guide/8796129>. 我的 → 账单 → ··· → 开具交易流水证明. It says the password is the last six digits of the ID number, which the other sources do not; trust what the app shows.
- "支付宝账单-手机端", Qianji (钱迹) user guide, 2021-07-28: <https://docs.qianjiapp.com/other/import_guide_alipay_app.html>. Zip by email, password in an Alipay notification.
- Alipay service center, 收支明细证明申请流程 (desktop proof of income and spending), undated: <https://cschannel.alipay.com/mobile/helpDetail.htm?help_id=553265>. Official, but only covers the older desktop flow, which produces a stamped proof rather than this CSV.

Last checked: 2026-10-01

## What yomi expects

| Item | Value |
|------|-------|
| Extension | `.csv` (the `.zip` is not accepted; unzip first) |
| Encoding | GBK, as Alipay writes it, with no byte order mark |
| Summary lines read | `共N笔记录` (N records), `收入：N笔 X元` (income), `支出：N笔 X元` (spending), `不计收支：N笔 X元` (not counted), `起始时间：[…] 终止时间：[…]` (period) |
| Header row | The row starting with `交易时间` (transaction time) |
| Required columns | `交易时间`, `交易分类` (category), `交易对方` (counterparty), `商品说明` (description), `收/支` (in/out), `金额` (amount), `交易状态` (status), `交易订单号` (order number) |
| Optional column | `收/付款方式` (payment method), used to find the bank card |
| Currency | CNY for every row |
| Time zone | Times are read as Beijing time (UTC+08:00) and grouped into days by the time zone in Settings > General |

Data rows end at the first blank line. Columns are matched by name, so their order does not matter.

How rows are read:

- `支出` becomes spending, `收入` becomes income.
- `不计收支` (not counted) becomes a transfer. yomi guesses the direction from keywords and warns when it cannot tell.
- Refund rows (`交易分类` = `退款` or `交易状态` = `退款成功`) become refunds. A purchase whose status is `交易关闭` (closed) is kept but marked closed, and its matching refund row becomes a transfer, so the money is not subtracted twice.
- Interest such as 余额宝收益 (Yu'e Bao earnings) becomes income.

## What yomi does with it

1. **Reconciliation.** Before anything is written, yomi adds up the rows it read per bucket (spending, income, not counted) and compares the count and amount with the summary at the top of the file. Closed rows count toward the row count but not the amount, which is how Alipay states it. The preview says "Matches the file's totals" or shows the difference.
2. **Backup.** The ledger is backed up to `data/backups/` before the import.
3. **Dedup.** Every row is keyed by its `交易订单号`. Importing the same file again is refused with "This file was already imported". You can import anyway: only rows not seen before are added. A later export that overlaps an earlier one only adds the new rows.
4. **Linking with bank cards.** When `收/付款方式` names a card, such as `工商银行信用卡(3141)`, yomi creates an account for that card. A bank row for the same card (last four digits), amount and currency within 3 days, from the [ICBC PDF](import-icbc.md), [bank sync](plaid.md) or a pasted ICBC SMS alert, is linked to the Alipay row. The Alipay row is the one that counts. If the bank row was already split, settled or edited, they are not linked and the preview warns you to check.
5. **Undo.** Every import is a batch under **Import history** on the Import page. **Revert** deletes the batch's transactions you have not edited (edited ones are kept) and lets you import the file again later.

## Import it

**Web:** open the Import page and drop the file on the drop zone, or choose it. You can drop several files at once (Alipay, WeChat, ICBC, Bank of America); they are previewed one after another. Check the preview, then click **Import**. When the totals do not match, tick "I have checked, import anyway" first.

**Terminal:**

```bash
pnpm import:files ~/Downloads/alipay-statement.csv
```

It prints one line per file (rows, new, duplicate, linked, and whether it reconciles) plus any notes. Add `--force` to import a file that was imported before. With the default embedded database, stop `pnpm dev` first: a PGlite directory can be open in one process only, and the command stops with a message saying which process holds it. The terminal import does not stop on a totals mismatch; it prints "does NOT reconcile", so read the output.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| "Unsupported files" | You dropped the `.zip`. Unzip it and drop the `.csv`. |
| "The header row (交易时间) was not found" | The file was re-saved (often as UTF-8 by a spreadsheet app) or is not the reconciliation export. Unzip the original again. |
| "Missing columns: …" | A different Alipay export (for example a business account). Use **For personal reconciliation**. |
| Totals do not match | Compare the preview's "File says" and "Parsed" columns. A row that cannot be read is skipped; tell us which line, without sharing real data. |
| "cannot tell which way a neutral row went" | A `不计收支` row with unfamiliar wording was booked as money out. Check it in Transactions and fix the amount sign if needed. |
| Card payment counted twice | The bank row is outside the 3-day window, has a different amount (fees, currency conversion), or was edited before the Alipay import. Edit one of them by hand. |

See also: [WeChat guide](import-wechat.md), [ICBC guide](import-icbc.md), [README](../README.md).
