# Upgrade from yomi v0.1 (SQLite) to v0.2 (Postgres)

Last checked: 2026-09-30

yomi v0.1 kept the ledger in one SQLite file, `data/yomi.db`. From v0.2 the ledger is a Postgres database: by default an embedded one ([PGlite](https://pglite.dev)) in the directory `data/pglite/`, so there is still nothing to install. v0.2 does not open the old file; you copy it once with `pnpm db:import-sqlite`. If you never ran v0.1, skip this guide.

## What happens if you skip it

- v0.2 refuses to start with an empty `data/pglite` while `data/yomi.db` exists next to it, and says why.
- It also refuses a `DATABASE_URL` that points at a `.db` file.

Nothing is changed or deleted in either case.

## Steps

1. **Stop yomi** (`Ctrl+C` in the terminal running `pnpm dev`).
2. **Update the code and dependencies:**

   ```bash
   git pull
   pnpm install
   ```

3. **Check `.env.local`.** If it sets `DATABASE_URL=data/yomi.db` (or any `.db` path), remove that line or point it at the new location. Keep `YOMI_SECRET_KEY` (or your key file) exactly as it is: the copy keeps encrypted credentials byte for byte, so the same key opens them.
4. **Copy the ledger** into the default `data/pglite`:

   ```bash
   pnpm db:import-sqlite data/yomi.db
   ```

   Or into another target, which must be empty:

   ```bash
   pnpm db:import-sqlite data/yomi.db --target data/other-pglite
   pnpm db:import-sqlite data/yomi.db --target postgres://user@host:5432/yomi
   ```

   Without `--target`, the target is `DATABASE_URL` from your shell, else `data/pglite`. `.env.local` is not read by this command.
5. **Read the verification.** The command compares both databases and prints aggregates only (no transaction or person names):
   - row counts per table;
   - per month and currency: transaction count and amount sum, split owed and paid sums, settlement sums;
   - holdings counts and market value per currency, balance snapshot counts;
   - a checksum verdict for stored secrets, and the settings keys copied.

   It exits with an error on any mismatch. The copy stays in the target so you can inspect it; move that directory aside (or drop that database) before trying again.
6. **Start yomi** with `pnpm dev` and look around: Transactions, Split and settle, Assets.
7. **Keep `data/yomi.db`** and its old `.db` backups until you are happy with the new ledger. The import only reads them. After that, delete them rather than copy them elsewhere: a v0.1 backup made before you set a secret key may hold Plaid tokens in plain text, and v0.2 does not read or rewrite `.db` files (`pnpm secrets:scrub-backups` handles only the new `.tar.gz` backups).

## What the copy does

- Copies every table in one transaction and keeps every id (the id sequences move past them, so new rows do not collide).
- Converts JSON text to `jsonb` and 0/1 flags to booleans.
- Copies encrypted secrets unchanged.

## Troubleshooting

| Message | Fix |
|---------|-----|
| "No SQLite ledger at ..." | Check the path; it is resolved from the directory you run the command in. |
| "The target database is not empty" | Nothing was written. Choose an empty directory, or move the existing `data/pglite` aside first (`mv data/pglite data/pglite-old`). |
| The database is in use by another process | Stop `pnpm dev` (a PGlite directory can be open in one process only). |
| Mismatch reported | Keep `data/yomi.db`, move the new target aside, and open an issue with the printed aggregates (they contain no names), not the database file. |

See also: [Back up and restore](backup-and-restore.md).
