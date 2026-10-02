# Contributing to yomi

Thanks for helping. yomi handles people's financial data, so the bar is: correct numbers, no private data anywhere in git, and both languages in the UI. This page covers setup, the conventions the code relies on, and how changes get in.

## Setup

Requirements: Node.js 24+, pnpm 10 (`corepack enable`), Git.

```bash
git clone https://github.com/averatec0773/yomi.git
cd yomi
pnpm install
pnpm hooks:install                     # private-path guard, see below
pnpm demo:db                           # synthetic ledger in data/demo-pglite
DATABASE_URL=data/demo-pglite pnpm dev # http://localhost:7773
```

Develop against the demo ledger or your own scratch copy, never against data you would mind losing. Background bank and holdings sync only run on the default ledger `data/pglite`, so a demo or scratch ledger never receives real bank data. To run two dev servers side by side, give each its own `NEXT_DIST_DIR`, `DATABASE_URL` and port (`NEXT_DIST_DIR=.next-b DATABASE_URL=data/demo-b-pglite PORT=7774 pnpm dev`).

## Commands

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Web app on http://localhost:7773 (`PORT=8000 pnpm dev` or `pnpm dev -p 8000` for another port) |
| `pnpm test` | Unit tests (Vitest); each test file gets its own in-memory PGlite |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm lint` | ESLint, including the framework-free rule for core, importers and contracts |
| `pnpm e2e` | Playwright; starts two servers (ports 3120 and 3420) on fresh demo ledgers. First time: `pnpm exec playwright install chromium` |
| `pnpm e2e:build && YOMI_E2E_PROD=1 pnpm e2e` | The same suite against a production build (`next start`), as CI runs it |
| `pnpm db:generate` | Drizzle migration after changing `packages/db/src/schema.ts` |
| `pnpm demo:db [dir]` | Rebuild a synthetic demo ledger (the directory name must contain "demo") |
| `pnpm demo:showcase [dir]` | Rebuild the English-only ledger used for README screenshots (default `data/demo-showcase-pglite`) |
| `pnpm import:files <files>` | Import statement files from the terminal |
| `pnpm hooks:install` | Install the private-path guard as git `pre-commit` and `pre-push` hooks (see below) |
| `pnpm guard` | Check that no tracked file is on the private path list |
| `pnpm db:import-sqlite <file>` | Copy a v0.1 SQLite ledger into the current one ([guide](guides/upgrade-from-v0.1.md)) |
| `pnpm secrets:gen-key` / `pnpm secrets:scrub-backups` | Print a new `YOMI_SECRET_KEY` / encrypt plaintext tokens left in `.tar.gz` backups |

All four of `test`, `typecheck`, `lint` and `e2e` must pass before a pull request is merged; CI runs them.

### Optional suites

- **Plaid Sandbox e2e** (`e2e/plaid-sandbox.spec.ts`, `e2e/plaid-sandbox-invest.spec.ts`) drive a real Plaid Link login in Plaid's Sandbox, so they need your own Plaid Sandbox keys, network access and a throwaway Postgres database (a PGlite directory cannot be shared between the server and the test). Start a server yourself, then run the specs against it:

  ```bash
  DATABASE_URL=postgres://localhost/yomi_plaid_e2e PLAID_ENV=sandbox PLAID_CLIENT_ID=... PLAID_SECRET_SANDBOX=... \
    YOMI_BACKGROUND_SYNC=0 NEXT_DIST_DIR=.next-plaid PORT=3160 pnpm dev
  PLAID_SANDBOX_E2E=1 PLAID_E2E_DB=postgres://localhost/yomi_plaid_e2e pnpm e2e
  ```

  The default `pnpm e2e` skips them; Plaid and IBKR are never called there (`YOMI_E2E=1` routes them to in-process fakes).
- **Real-data checks** (`packages/importers/src/real-data.*.test.ts`) run only when you put your own exports under `data/raw/` (gitignored: `alipay/*.csv`, `wechat/*.xlsx`, `ICBC/*.pdf`, `BOA/stmt*.csv`). They assert that each file reconciles with its declared totals and print aggregates only. Never commit those files.

## Architecture

A TypeScript monorepo (pnpm workspaces). Packages export TypeScript source directly; there is no build step for them. The ledger is Postgres through Drizzle: an embedded [PGlite](https://pglite.dev) directory by default, or a Postgres server via `DATABASE_URL` ([configuration](guides/configuration.md)).

| Path | Responsibility |
|------|----------------|
| `apps/web` | Next.js App Router pages and components; server components read through core, client components call the API. `components/README.md` documents the shared UI kit |
| `packages/core` | Ledger rules: import pipeline, dedup, categories, splits, settlements, stats, assets, sync jobs, CLIs. No framework imports |
| `packages/db` | Drizzle schema, migrations, client (PGlite or Postgres), backups, directory lock, v0.1 SQLite import |
| `packages/importers` | Statement parsers (Alipay, WeChat, ICBC PDF and SMS, Bank of America CSV) and the Plaid and IBKR Flex clients and mappers. File in, normalized rows out; never touches the database |
| `packages/contracts` | Zod schemas for API inputs and outputs, shared by the API and the web app (MIT) |
| `packages/api` | Hono HTTP API mounted inside the Next.js app; thin routes over core |
| `e2e` | Playwright end-to-end tests on a synthetic demo ledger |
| `guides` | User guides; keep them in step with the UI |
| `tools/hooks` | Git hooks that keep private files out of commits |

## Conventions

- **Core has no framework imports.** `packages/core`, `packages/importers` and `packages/contracts` must not import Next.js, React or Hono (lint enforces it). Routes and pages call core; core can run from a plain Node script.
- **Money is integer minor units plus a currency.** Cents and fen, stored as integers with a `currency` column. A float anywhere in money math is a bug. Never sum different currencies without a stated rate and date. Format through the shared money formatter.
- **Every UI string goes through i18n.** Add each new string to both `apps/web/i18n/en.ts` and `apps/web/i18n/zh-CN.ts`; never hardcode copy in a component. Core and the API return stable error codes with an English message; the UI translates by code. Write plain, non-judgmental copy in sentence case.
- **The database layer is async.** Everything that touches the database returns a promise; pure functions stay synchronous. Every row carries `user_id`, obtained through `getCurrentUser()`.
- **Drizzle 0.45, SQL-style only.** Use the query builder (`select().from().where()`), not the relational API. New migrations come from `pnpm db:generate`; add `COLLATE "C"` to new text columns by hand. Do not change how dedup keys are computed without migrating existing rows in the same change.
- **Importers match headers by name**, keep the raw row, and return the totals the file declares so every import can be reconciled.
- **Tests are required.** New behavior comes with unit tests; user-visible flows get an e2e test. Fixtures are synthetic: fictional names (Alex, Sam), card tails like 3141 or 5501, `example.com` emails, 555 phone numbers. Never commit a real statement, even "anonymized".
- **UI:** reuse the components in `apps/web/components/ui-kit` and the tokens in `app/globals.css`; one icon set (lucide); calm colors that carry meaning only; light and dark themes both work.

## Keep private data out (the guard)

`pnpm hooks:install` adds git `pre-commit` and `pre-push` hooks (plain shell, in `tools/hooks/`) that refuse to commit or push:

- `data/`, `docs/`, `conventions/`, `memory/`, `loop/`, `scripts/`, `changelog/`, `.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`, `ROADMAP.md`, `CHANGELOG.md`, `Makefile`;
- `.env` files except `.env.example`;
- databases (`*.db`, `*.sqlite`), mail files (`*.eml`) and key files (`*.key`, `*.pem`, `*.p12`).

If `data/private-denylist.txt` exists on your machine (one literal string per line: your name, account numbers, merchant names you never want public), the hooks also reject staged or pushed content containing any of them, printing only file names. If you already have hooks, the installer keeps yours as `<hook>.local` and runs it after the guard. CI runs the same path check on every push.

## Commits and pull requests

- Branch from `main`; one feature or fix per pull request. Pull requests are squash-merged, so the title becomes the commit on `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org) for titles: `feat(import): read WeChat refunds`, `fix(split): round shares toward the payer`, `docs(guides): Plaid OAuth banks`.
- Describe what changes for the user and how you checked it (commands run, pages looked at).
- Screenshots must show the demo ledger or other fictional data.

## Contributor License Agreement

Outside contributions are accepted under the [yomi Individual Contributor License Agreement](CLA.md). It lets the project owner relicense contributions (for example to keep `packages/contracts` MIT or to offer other licenses) while you keep your copyright. On your first pull request the CLA Assistant bot asks you to reply with a sentence that signs it; this is recorded once for all your future contributions.

## Reporting bugs and requesting features

Open an issue using the templates. Never paste real statements, transaction rows, account numbers, tokens or `.env.local` contents. Describe the shape of the data instead (headers, which column looks odd), or attach a small file with made-up values. For a new statement source, the export format and its exact column headers are the most useful thing you can share.
