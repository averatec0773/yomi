# Import an ICBC credit card statement

ICBC (工商银行, Industrial and Commercial Bank of China) lets you export your credit card history as a PDF. yomi reads the text of that PDF on your computer, checks it against the per-page totals ICBC prints, and adds each charge, refund and card payment to your ledger, in the currency it was booked in. It also records the card balance from the statement. Charges you paid through Alipay or WeChat are linked to those rows so they count once, and you can add a charge right away by pasting the ICBC text message alert.

## Get the file

yomi reads the **credit card history details (electronic version)**, a PDF titled 中国工商银行信用卡历史明细（电子版）. It is not the monthly credit card statement (对账单) that ICBC can email on the day after each statement date: that document has a different layout and is not supported yet.

1. In the ICBC (工商银行) mobile app, open the history details print feature (历史明细打印). Third-party guides reach it from the account page's **More** (更多) menu or by searching the app for 历史明细打印.
2. Pick your credit card as the account, choose the period and enter the email address that should receive the file.
3. Confirm the request with the SMS code. ICBC emails the PDF. If the file asks for a password, third-party guides say it is shown in the app under the request's progress (办理进度).
4. Save the `.pdf` as delivered. Debit card history, scans and photos are not supported.

Sources:

- ICBC, 个人历史明细查询-打印 (personal history details: query and print), official video page, posted 2026-04-23 (video from January 2022): <https://www.icbc.com.cn/page/721852515087056934.html>. Confirms the feature name; the steps are only in the video, which was not reviewed.
- ICBC credit card channel, 工商银行信用卡电子账单 (credit card e-statements), undated: <https://www.icbc.com.cn/page/721853479282049024.html>. The monthly Email statement is sent the day after the statement date; this is the 对账单 that yomi does not read.
- 工商银行手机app怎么打流水 (how to print account history in the ICBC app), jb51.net, 2021-10-09: <https://www.jb51.net/softjc/792988.html>. Search 历史明细打印, choose the account, period and receiving email, confirm with an SMS code.
- 常用：各银行流水查询及下载指南 (how to download account history from each bank), GitHub gist by iqiancheng, last active 2026-05-26: <https://gist.github.com/iqiancheng/e5f84b3fcaad3319bb53d7a3064d4514>. 我的账户 → 更多 → 历史明细打印; the file password is under 我的 → 办理进度.

Menu names may differ by app version; not verified against an official page.

## What yomi expects

| Item | Value |
|------|-------|
| Extension | `.pdf` with real text (not a scan or photo) |
| Header row | `入账日期` (posting date), `交易卡号` (card number), `收/支` (in/out), `交易币种` (transaction currency), `交易金额` (transaction amount), `入账币种` (booked currency), `入账金额` (booked amount), `账户余额` (balance), `对方户名`, `对方账号` (counterparty), `摘要` (summary), `交易场所` (place) |
| Page footer read | `本页支出算术合计` (page spending total), `本页收入算术合计` (page income total), `本页交易笔数` (page row count) |
| Period | `起止日期` (start and end date) |
| Direction | `借` (debit) is money out, `贷` (credit) is money in |
| Currencies | `美元` USD, `港币` HKD, `人民币` CNY. The booked amount is what counts; a different transaction currency is kept as the original amount |
| Time zone | Posting times are read as Beijing time (UTC+08:00) and grouped into days by the time zone in Settings > General |

Columns are found by their header text and position on the page, so the diagonal watermark is ignored. Only the last four digits of the card number are kept.

How rows are read: debits are spending; credits whose place mentions a rebate or cash back are income; credits with summary `退货` (return) are refunds; other credits (such as card payments) are transfers.

## What yomi does with it

1. **Reconciliation.** yomi adds up the page footers and compares them with what it read: row count, spending and income. ICBC's page totals add USD and HKD amounts together without conversion, so yomi compares the same mixed sum. Each page is also checked on its own, and a page whose row count differs is named in the preview.
2. **Backup.** The ledger is backed up to `data/backups/` before the import.
3. **Card account and balance.** An account named after the card (for example 工商银行信用卡 3141) is created. The last `账户余额` on the statement is stored as the card's balance on the Assets page.
4. **Dedup.** ICBC rows have no transaction number, so each row is keyed by card, time, amount, currency and text. Importing the same file again is refused with "This file was already imported"; importing anyway only adds rows not seen before. Overlapping exports only add new rows; two identical charges in one file are both kept.
5. **Linking.** A new ICBC row is linked to:
   - a pasted SMS alert for the same charge (see below), which stays the primary row so its split, category and note survive;
   - otherwise, an [Alipay](import-alipay.md) or [WeChat](import-wechat.md) row paid with the same card (last four digits), same amount and currency, within 3 days. The wallet row counts and the card row is kept as its duplicate. If you import Alipay or WeChat later, the link is made then, unless you already split, settled or edited the card row (then the preview warns you).
6. **Undo.** Each import is a batch under **Import history** on the Import page. **Revert** deletes the batch's transactions you have not edited and the balance it stored, and lets you import the file again.

## Import it

**Web:** open the Import page and drop the PDF on the drop zone, or choose it. Several files at once are fine. Check the preview, then **Import**. When totals do not match, tick "I have checked, import anyway" first.

**Terminal:**

```bash
pnpm import:files ~/Downloads/icbc-history.pdf
```

`--force` imports a file seen before. With the default embedded database, stop `pnpm dev` first (a PGlite directory can be open in one process only; the command refuses while the server holds it). The terminal import does not stop on a mismatch; it prints "does NOT reconcile".

## SMS alerts

ICBC texts you after each card charge. You can add that charge before the PDF exists:

1. Copy the whole text message.
2. In yomi, press ⌘K (Ctrl+K on Windows and Linux) to open **Add**, paste it, add people to split with if you want, and press Enter.

A supported alert looks like this (fictional):

```
您尾号3141信用卡9月27日08:24POS支出(消费SAMPLE CAFE Houston)15.74美元。【工商银行】
```

- yomi reads the card's last four digits, date and time (Beijing time; the year is inferred), the direction word (`支出` spending, or `收入` / `存入` / `退货` / `退款` for credits), the merchant and city, and the amount in `美元` USD, `港币`/`港元` HKD or `人民币`/`元` CNY. Text after the amount is ignored.
- Pasting the same alert twice does not add it twice ("This alert is already in the ledger").
- If the PDF row (or an Alipay or WeChat row paid with that card) is already in the ledger, the alert is linked to it and counts once.
- When you import the PDF later, its row for the same card, amount and currency within 3 days, with an overlapping merchant name, is linked to the alert. The alert stays the counted row; an empty merchant is filled in from the statement.
- Alerts are not part of an import batch, so reverting a PDF batch does not remove them.

Only ICBC credit card alerts are read. Other banks' messages are not supported yet.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| "Page N: header row not found" or no rows | The PDF has no text layer (a scan, a photo, a printed-to-PDF image) or is another ICBC document. Export the electronic version again. |
| Any PDF is treated as ICBC | yomi treats every `.pdf` as an ICBC credit card history. Other PDFs are not supported. |
| "Page N: read X rows, the page declares Y" | A row could not be placed. Check that page against the PDF and add the missing row by hand; please report the layout without sharing real data. |
| Totals off by a converted amount | Foreign charges are booked in the card's currency; the original amount is kept separately. Compare booked amounts. |
| SMS not recognized | Paste the full message including the amount and currency. Debit card and other banks' alerts are not supported. |
| Charge counted twice | The rows are more than 3 days apart, the amounts differ, or one was edited before linking. Fix one of them by hand. |

See also: [Alipay guide](import-alipay.md), [WeChat guide](import-wechat.md), [README](../README.md).
