# Back up and restore your ledger

Last checked: 2026-09-30

yomi keeps everything on your computer, so backups are your job. yomi helps by taking a copy automatically before anything risky, and you can copy by hand at any time. This guide covers what to back up, where the automatic copies are, and how to restore one.

## What to back up

| What | Default location | Why it matters |
|------|------------------|----------------|
| The ledger | `data/pglite/` (a PGlite data directory), or the Postgres server in `DATABASE_URL` | All transactions, splits, settlements, settings |
| Automatic backups | `data/backups/` | Copies taken before upgrades, imports and undos |
| The secret key | `~/.config/yomi/secret.key`, or `YOMI_SECRET_KEY` in `.env.local` | Opens the encrypted bank and brokerage credentials |
| Your configuration | `.env.local` at the repository root (if you use one) | Plaid and IBKR keys, access token, database location |

Keep the secret key in a password manager, separately from the ledger. A ledger backup without the key still has every transaction, but saved credentials (Plaid access tokens, the IBKR token, keys entered in Settings) cannot be read; you would reconnect those.

## Automatic backups

For a PGlite ledger, yomi writes a `.tar.gz` of the whole data directory to a `backups/` folder next to it (`data/backups/` by default):

- before every database upgrade (when a new version adds a migration), named `pglite-<date>-<time>-pre-migrate.tar.gz`;
- before every import and every import undo (`pre-import`, `pre-revert`);
- before encrypting stored credentials for the first time (`pre-encrypt`).

The newest 10 of each kind are kept; older ones are deleted. Each copy is taken between queries, so it is consistent even while yomi runs.

## Back up by hand

1. Open **Settings > Data** and click **Back up ledger**. The new file appears in `data/backups/`.
2. Copy `data/backups/` (or just the newest file) to another disk or a cloud drive you trust.
3. Copy the secret key file or value to your password manager if you have not already.

Before copying backups anywhere: backups made before you set a secret key may hold credentials in plain text. `pnpm secrets:scrub-backups` lists how many plaintext tokens each `.tar.gz` backup in `data/backups/` holds (counts only); add `--apply` to encrypt them in place with the current key. It does not read v0.1 `.db` files.

### Postgres server

yomi does not copy a Postgres server. Use `pg_dump`, for example from the repository root:

```bash
pg_dump --format=custom --file=data/backups/yomi-$(date +%Y%m%d-%H%M%S).dump "$DATABASE_URL"
```

Settings > Data shows this command when the ledger is on a server. Restore with `pg_restore` into an empty database.

## Restore a PGlite backup

1. Stop yomi (`Ctrl+C` in the terminal running `pnpm dev`). A PGlite directory can be open in one process only.
2. Move the current ledger aside instead of deleting it:

   ```bash
   mv data/pglite data/pglite-before-restore
   ```

3. Unpack the backup into a fresh directory:

   ```bash
   mkdir data/pglite
   tar -xzf data/backups/<backup>.tar.gz -C data/pglite
   ```

4. Start yomi again with `pnpm dev` and check the Transactions page.
5. When you are happy, delete `data/pglite-before-restore`.

To look at a backup without replacing your ledger, unpack it into another directory whose name you choose (for example `data/restore-check`) and start yomi on it with `DATABASE_URL=data/restore-check pnpm dev`. Background sync stays off on any ledger other than `data/pglite`, so the copy never receives new bank data.

## Undo a single import instead

If one import went wrong, you do not need a full restore: open **Import**, find the batch in **Import history** and click **Revert**. That removes exactly the rows the batch added (a `pre-revert` backup is taken first).

## Export as CSV

CSV export is for spreadsheets, not for restoring. It is available on Transactions, Analysis (any period) and each statement on Split and settle, as UTF-8 with a byte order mark so Excel opens Chinese text correctly.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "The yomi database at ... is in use by another process" | Another `pnpm dev`, `pnpm import:files` or `pnpm demo:db` has it open. Stop that process, or wait for it to finish. |
| After a restore, bank sync says the key is missing or wrong | The backup was taken with a different secret key. Put that key back (`YOMI_SECRET_KEY` or the key file) and restart. |
| `tar` reports an error | The file is not a yomi PGlite backup (for example a v0.1 `.db` file). See [Upgrade from v0.1](upgrade-from-v0.1.md). |
