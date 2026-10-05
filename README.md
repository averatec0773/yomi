**English** | [简体中文](README.zh-CN.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/wordmark-light.svg">
    <img src="apps/web/public/brand/wordmark.svg" alt="yomi" width="200">
  </picture>
</p>

A self-hosted personal ledger for people whose money lives in both the US and China: Alipay, WeChat Pay, ICBC and US bank statements in one list, shared costs split with friends, and your data on your own computer.

![The Transactions page with demo data, dark theme](guides/images/transactions-dark.webp)

**Status:** v0.2.5, an early release used daily by its author.

## Features

- **Statement imports** for Alipay CSV, WeChat Pay xlsx, ICBC credit card PDF and SMS alerts, and Bank of America CSV. Every file is checked against its own totals before import, and every import can be undone.
- **No double counting.** A payment that appears in Alipay and again on the card behind it is recorded once; re-importing a file adds only new rows.
- **CNY and USD side by side.** Amounts keep their own currency and are never summed across currencies without a stated rate.
- **Split and settle.** Tag rows with the people who share them, see what is open per person and currency, and send a clean statement as PDF, image or text with your payment QR codes.
- **Bank and brokerage sync** through Plaid (with your own keys) and Interactive Brokers Flex.
- **Analysis and assets:** spending by category for any period, monthly targets, net worth and holdings.
- **Quick entry and a bilingual UI:** press ⌘K and type `lunch 35 @Alex`; English and Simplified Chinese, light and dark themes.

## Quick start

Requirements:

- [Node.js](https://nodejs.org) 24 or newer
- [pnpm](https://pnpm.io) 10 (`corepack enable` picks the pinned version)
- Git
- macOS, Linux or Windows (WSL recommended)

No database server is needed.

```bash
git clone https://github.com/averatec0773/yomi.git
cd yomi
pnpm install
pnpm dev
```

Open http://localhost:7773. yomi creates its ledger in `data/pglite/` (an embedded Postgres, nothing else to install). Then open **Import** and drop a statement file.

To look around with fictional data first:

```bash
pnpm demo:db
DATABASE_URL=data/demo-pglite pnpm dev
```

To update later: `git pull && pnpm install && pnpm dev`. Database upgrades run on start, after an automatic backup.

## Configuration

Nothing is required. Bank and brokerage credentials are entered in **Settings > Connections** and stored encrypted. To manage settings as code instead, copy [`.env.example`](.env.example) to `.env.local`; a value there wins over Settings. Every variable, the ledger location (`DATABASE_URL`, including a Postgres server) and the encryption key are described in [guides/configuration.md](guides/configuration.md).

## Guides

- [Using yomi](guides/using-yomi.md): imports, splitting, statements, quick entry, updates
- [Configuration](guides/configuration.md): data locations, environment variables, credentials, privacy
- [Import an Alipay statement](guides/import-alipay.md)
- [Import a WeChat Pay statement](guides/import-wechat.md)
- [Import an ICBC credit card statement](guides/import-icbc.md)
- [Import a Bank of America CSV](guides/import-boa.md)
- [Connect banks and brokerages with Plaid](guides/plaid.md)
- [Connect Interactive Brokers](guides/ibkr.md)
- [Open yomi from your phone](guides/remote-access.md)
- [Back up and restore](guides/backup-and-restore.md)
- [Troubleshooting](guides/troubleshooting.md)

## Privacy

yomi is local-first: the ledger, backups and statement files stay on your computer, and there is no yomi server and no telemetry. It connects out only for features you use (Plaid, Interactive Brokers, and daily exchange rates from Frankfurter). Stored credentials are encrypted with AES-256-GCM using a key kept outside the repository; back that key up in a password manager. `pnpm dev` listens on your local network, so set `YOMI_ACCESS_TOKEN` before opening yomi from a phone or another computer ([guide](guides/remote-access.md)). Details: [guides/configuration.md](guides/configuration.md#privacy-and-network-access).

## Contributing

Bug reports, new statement sources and fixes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture and conventions. Outside contributions are accepted under a [Contributor License Agreement](CLA.md) that a bot asks you to sign on your first pull request. Never attach real statements or screenshots of real data to issues.

## License

- yomi is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only).
- `packages/contracts` is licensed under the [MIT License](packages/contracts/LICENSE).
- "yomi" and its logo are trademarks of the project owner; forks that are distributed or offered as a service must use a different name. See [TRADEMARK.md](TRADEMARK.md).
