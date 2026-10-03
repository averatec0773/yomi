# Import a WeChat Pay statement

WeChat Pay (微信支付) can export your bills for a period as a spreadsheet. yomi reads it on your computer, checks it against the totals WeChat prints above the table, and adds each payment, transfer, red packet and refund to your ledger. A purchase paid with a bank card through WeChat is linked to the same charge on the card statement, so it counts once.

## Get the file

1. In WeChat, go to **Me → Services → Wallet**, tap **Bills** at the top right, then tap **FAQ** at the top right of the Bills page and choose **Download bills** (我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单).
2. Choose **For personal reconciliation** (用于个人对账). The other purpose, for proof (用作证明材料), also includes records you deleted.
3. Choose the period, enter the email address that should receive it (for example `sam@example.com`), and verify your identity with your payment password as the page asks.
4. WeChat Pay emails the bill within 24 hours as a password-protected archive. The unzip code (解压码) arrives as a message from the WeChat Pay (微信支付) official account in WeChat. WeChat recommends downloading and unzipping on a computer.
5. Unzip it to get the `.xlsx` file (older exports are `.csv`). Do not open and re-save the file before importing.

Sources:

- Tencent Customer Service (腾讯客服), 微信账单怎么下载 (how to download WeChat bills), undated page with step screenshots from June 2024: <https://kf.qq.com/faq/230919ZBVz6n2309193qMvii.html>. 我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单, then 用于个人对账 or 用作证明材料.
- Tencent Customer Service, 微信支付如何导出账单 (how to export WeChat Pay bills), undated: <https://kf.qq.com/touch/sappfaq/190314vE7VZF190314ZVreAz.html>. Bills arrive by email within 24 hours; unzip on a computer.
- Tencent Customer Service, 如何下载与上传微信账单（电脑端）, undated (screenshots from 2021): <https://kf.qq.com/touch/faq/2106213MfYbY210621JjuuUb.html>. Email address, payment password, and the unzip code sent by the WeChat Pay official account. Its path starts at 我 → 支付 → 钱包, the older name of 服务.

The file type (`.xlsx`) is not stated on these pages; it is what current exports contain.

Last checked: 2026-10-01

## What yomi expects

| Item | Value |
|------|-------|
| Extension | `.xlsx` (current exports) or `.csv` (older exports) |
| Encoding | xlsx: the first worksheet is read. CSV: UTF-8 **with** a byte order mark, as WeChat writes it |
| Summary lines read | `共N笔记录` (N records), `收入：N笔 X元` (income), `支出：N笔 X元` (spending), `中性交易：N笔 X元` (neutral), `起始时间：[…] 终止时间：[…]` (period) |
| Header row | The row starting with `交易时间` (transaction time) |
| Required columns | `交易时间`, `交易类型` (type), `交易对方` (counterparty), `商品` (item), `收/支` (in/out), `金额(元)` (amount in yuan), `当前状态` (status), `交易单号` (transaction number) |
| Optional column | `支付方式` (payment method), used to find the bank card |
| Currency | CNY for every row |
| Time zone | Times are Beijing time (UTC+08:00), as the file states, and are grouped into days by the time zone in Settings > General |

Amounts may be number cells (xlsx) or text like `¥12.00` (CSV). Columns are matched by name. Data rows end at the first row that does not start with a date.

How rows are read:

- `支出` becomes spending; `收入` becomes income (transfers and red packets included, as WeChat's own summary counts them).
- `/` (neutral, 中性交易) becomes a transfer. yomi guesses the direction from keywords (for example 零钱提现, a withdrawal, is money out) and warns when it cannot tell.
- A `交易类型` ending in `-退款` becomes a refund. A purchase marked `已全额退款` (fully refunded) stays a purchase; the refund is its own row.

## What yomi does with it

1. **Reconciliation.** yomi totals the rows it read per bucket and compares count and amount with the summary in the file before writing anything. The preview says "Matches the file's totals" or shows the difference.
2. **Backup.** The ledger is backed up to `data/backups/` before the import.
3. **Dedup.** Every row is keyed by its `交易单号`. Importing the same file again is refused with "This file was already imported"; importing anyway only adds rows not seen before. Overlapping exports only add the new rows.
4. **Linking with bank cards.** When `支付方式` names a card, such as `工商银行信用卡(3141)`, yomi creates an account for it. A bank row for the same card (last four digits), amount and currency within 3 days, from the [ICBC PDF](import-icbc.md) or [bank sync](plaid.md), is linked to the WeChat row, and the WeChat row is the one that counts. If the bank row was already split, settled or edited, they are not linked and the preview warns you. A pasted ICBC SMS alert for the card within 10 minutes of the WeChat row is replaced by it the same way, or, when you split, settled or edited the alert, stays the counted row with the WeChat row as its duplicate (see [SMS alerts](import-icbc.md#sms-alerts)).
5. **Undo.** Each import is a batch under **Import history** on the Import page. **Revert** deletes the batch's transactions you have not edited and lets you import the file again.

## Import it

**Web:** open the Import page and drop the file on the drop zone, or choose it. Several files at once are fine; each one gets its own preview. Click **Import** after checking the preview. When totals do not match, tick "I have checked, import anyway" first.

**Terminal:**

```bash
pnpm import:files ~/Downloads/wechat-bills.xlsx
```

It prints rows, new, duplicate, linked and whether the file reconciles. `--force` imports a file seen before (only new rows are added). With the default embedded database, stop `pnpm dev` first: a PGlite directory can be open in one process only, and the command refuses to run while the server holds it. The terminal import does not stop on a totals mismatch; it prints "does NOT reconcile".

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| "Unsupported files" | You dropped the archive. Unzip it first. |
| CSV read as Alipay, "header row (交易时间) was not found" | yomi tells a WeChat CSV from an Alipay CSV by its byte order mark. A re-saved CSV can lose it. Use the original file. |
| "The xlsx file has no worksheet" | The file is damaged or not the WeChat export. Download it again. |
| "has more than two decimals" | An amount cell was changed by hand in a spreadsheet. Use the original file. |
| Any `.xlsx` is treated as WeChat | yomi treats every `.xlsx` as a WeChat statement. Other spreadsheets fail with "header row not found". |
| Card payment counted twice | The bank row is more than 3 days away, has a different amount, or was edited before. Fix one of them by hand. |

See also: [Alipay guide](import-alipay.md), [ICBC guide](import-icbc.md), [README](../README.md).
