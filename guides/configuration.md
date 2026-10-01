# Configuration

Last checked: 2026-09-30

Everything here is optional: `pnpm install && pnpm dev` runs yomi with sensible defaults. This guide lists where yomi keeps its data, every setting, and how credentials are protected.

## Where your data lives

| What | Where | Notes |
|------|-------|-------|
| Ledger | `data/pglite/` | [PGlite](https://pglite.dev) data directory (an embedded Postgres); one process at a time can open it |
| Backups | `data/backups/` | Automatic before upgrades, imports and undos; 10 kept per kind ([guide](backup-and-restore.md)) |
| Secret key | `~/.config/yomi/secret.key` | Created when you first save a credential in Settings, or use `YOMI_SECRET_KEY` |
| Configuration | `.env.local` at the repository root | Optional; copy from [`.env.example`](../.env.example) |

`data/` and `.env*` files are in `.gitignore`. On the first run yomi creates the ledger and seeds the default categories.

### Choosing a ledger with `DATABASE_URL`

| Value | Ledger |
|-------|--------|
| unset | `data/pglite/` |
| a path, absolute or relative to the repository root | a PGlite directory there, created on first use |
| `postgres://user:password@host:5432/yomi` | a Postgres server (pool size `DATABASE_POOL_MAX`, default 10) |
| `memory://` | in memory, gone when the process exits (tests) |

A PGlite directory can be open in one process only. While `pnpm dev` runs, `pnpm import:files`, `pnpm invest:sync` and `pnpm demo:db` on the same directory stop with a message naming the process that holds it.

To try yomi on fictional data first, build a demo ledger and start on it:

```bash
pnpm demo:db                               # writes data/demo-pglite
DATABASE_URL=data/demo-pglite pnpm dev
```

## Two ways to configure

- **Settings > Connections** in the app: credentials are stored encrypted in the ledger. This is the easy path.
- **`.env.local`** at the repository root, for configuration as code. Copy [`.env.example`](../.env.example) and fill in what you need. An environment variable wins over Settings and shows there as read-only. Restart `pnpm dev` after editing it.

### Environment variables

| Variable | Required | Default | What it does | Guide |
|----------|----------|---------|--------------|-------|
| `DATABASE_URL` | No | `data/pglite` | Ledger location (see above) | [Backup and restore](backup-and-restore.md) |
| `DATABASE_POOL_MAX` | No | `10` | Connection pool size for a Postgres server | |
| `YOMI_SECRET_KEY` | No | key file | 32-byte key (base64 or hex) that encrypts stored credentials; generate with `pnpm secrets:gen-key` | [below](#credentials-and-encryption) |
| `YOMI_SECRET_KEY_FILE` | No | `~/.config/yomi/secret.key` | Where the key file lives when `YOMI_SECRET_KEY` is unset (`$XDG_CONFIG_HOME` is honored) | |
| `YOMI_ACCESS_TOKEN` | Before any access from another device | unset (no gate) | Token every browser must present once; generate with `openssl rand -hex 32` | [Remote access](remote-access.md) |
| `PLAID_CLIENT_ID` | For bank sync | | Plaid client ID (Dashboard > Developers > Keys) | [Plaid](plaid.md) |
| `PLAID_SECRET_SANDBOX` | For Sandbox | | Plaid Sandbox secret (test banks) | [Plaid](plaid.md) |
| `PLAID_SECRET_PRODUCTION` | For real banks | | Plaid Production secret | [Plaid](plaid.md) |
| `PLAID_ENV` | No | Production if it has a secret, else Sandbox | Environment for new connections (`sandbox` or `production`) | [Plaid](plaid.md) |
| `PLAID_SECRET` | No | | Older single-secret form, for the environment `PLAID_ENV` names | [Plaid](plaid.md) |
| `IBKR_FLEX_TOKEN` | For IBKR | | Flex Web Service token | [IBKR](ibkr.md) |
| `IBKR_FLEX_QUERY_ID` | For IBKR | | Activity Flex Query ID | [IBKR](ibkr.md) |
| `YOMI_BACKGROUND_SYNC` | No | on for `data/pglite` only | `1` runs background bank and holdings sync on any ledger, `0` turns it off everywhere | |
| `PORT` | No | `7773` | Port for `pnpm dev`; set it in the shell (`PORT=8000 pnpm dev`) or pass `pnpm dev -p 8000`, not in `.env.local` | |
| `NEXT_DIST_DIR` | No | `.next` | Build directory, to run several dev servers side by side | |
| `LOCAL_MODE` | No | `true` | Single-user mode; leave it unset (multi-user login does not exist yet) | |

### Credentials in Settings > Connections

| Credential | Required | Where to get it | Guide |
|------------|----------|-----------------|-------|
| Plaid client ID | For bank or brokerage sync | [dashboard.plaid.com](https://dashboard.plaid.com) > Developers > Keys | [Plaid](plaid.md) |
| Plaid Sandbox secret | For test banks | Same Keys page | [Plaid](plaid.md) |
| Plaid Production secret | For real banks | Same Keys page, after Plaid grants Production access | [Plaid](plaid.md) |
| Default environment | No | Your choice: Sandbox or Production | [Plaid](plaid.md) |
| IBKR Flex token, with its expiry date | For IBKR | Client Portal > Flex Web Service Configuration | [IBKR](ibkr.md) |
| IBKR Flex query ID | For IBKR | Client Portal > Flex Queries | [IBKR](ibkr.md) |

Saved secrets are write-only: Settings shows only the last four characters, never the value. Bank passwords are never entered in yomi; you log in inside Plaid's window.

## Credentials and encryption

- Plaid access tokens, Plaid keys and the IBKR token are stored in the ledger encrypted with AES-256-GCM.
- The key is `YOMI_SECRET_KEY` when set, otherwise the key file `~/.config/yomi/secret.key` (permissions 0600, outside the repository and `data/`), created the first time you save a credential in Settings.
- If you configure Plaid only through `.env.local` and have no key yet, tokens are stored unencrypted and Settings says so. Run `pnpm secrets:gen-key`, set `YOMI_SECRET_KEY`, restart, and existing tokens are encrypted in place after a backup.
- `pnpm secrets:scrub-backups` finds plaintext tokens left in older `.tar.gz` backups; add `--apply` to encrypt them in place.
- Back up the key in a password manager. Without it, stored credentials cannot be decrypted and you reconnect the banks. The key sits on the same disk, so encryption protects a leaked database or backup file, not a compromised computer.

## Privacy and network access

- **Local-first.** The ledger, backups and statement files stay on your computer. yomi has no server of its own and no telemetry.
- **Outbound connections**, only when you use the feature: Plaid (bank and brokerage sync, and the Plaid Link script from `cdn.plaid.com` when connecting), Interactive Brokers (Flex statements), and [Frankfurter](https://frankfurter.dev) for daily exchange rates on Assets (currency codes only).
- **Bank passwords** are typed only into Plaid's window and the bank's own page. yomi stores the access token Plaid issues.
- **Access token gate.** `pnpm dev` listens on every network interface. With `YOMI_ACCESS_TOKEN` set, every page and API call needs the access cookie (a SHA-256 hash of the token, HttpOnly, one year) or an `Authorization: Bearer <token>` header. Without it, anyone who can reach the port can use yomi. See [Remote access](remote-access.md).
- **Real data stays out of git.** `data/`, `.env*` (except `.env.example`), databases and key files are ignored, and `pnpm hooks:install` adds hooks that refuse to commit or push them.

See also: [Troubleshooting](troubleshooting.md), [Backup and restore](backup-and-restore.md).
