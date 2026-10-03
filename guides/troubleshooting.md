# Troubleshooting

Last checked: 2026-09-30

Common problems and their fixes. Each guide also has its own troubleshooting table: [Plaid](plaid.md#troubleshooting), [IBKR](ibkr.md#troubleshooting), [Remote access](remote-access.md#troubleshooting), [Backup and restore](backup-and-restore.md#troubleshooting).

| Symptom | Fix |
|---------|-----|
| "The yomi database at ... is in use by another process" | A PGlite directory can be open in one process only. Stop the other `pnpm dev` or CLI, or point one of them at another `DATABASE_URL`. |
| The import preview says the totals do not match | The file was changed or cut off. Export it again; import anyway only after checking. |
| An OAuth bank (Bank of America, Chase) refuses Plaid | Fill in the company profile under Compliance in the Plaid Dashboard ([guide](plaid.md)). |
| Connected a bank but no transactions yet | Plaid prepares the first pull after login; wait a few minutes and press **Sync now**. |
| IBKR says the statement is not ready or not published yet | IBKR builds statements asynchronously and usually publishes the day's statement after midnight New York. yomi keeps the last one and retries overnight; **Sync now** tries again ([guide](ibkr.md)). |
| "YOMI_SECRET_KEY is missing or wrong" | Restore the key that encrypted the credentials (`YOMI_SECRET_KEY` or the key file) and restart. Nothing was deleted. |
| Another device shows the Access page | Open `http://<computer>:7773/?token=<token>` once on that device, with the token from `YOMI_ACCESS_TOKEN` ([guide](remote-access.md)). |
| Port 7773 is taken | Start on another port: `PORT=8000 pnpm dev`. |

If none of these help, open an issue. Describe the shape of the data (headers, which column looks odd) and never attach real statements, account numbers, tokens or `.env.local` contents.
