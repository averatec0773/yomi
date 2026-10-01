# Connect banks and brokerages with Plaid

Last checked: 2026-09-30

yomi can pull transactions from US banks (for example Bank of America checking, savings and credit cards) and holdings from US brokerages through [Plaid](https://plaid.com), with no statement downloads. You run yomi yourself, so you bring your own Plaid developer keys. Bank passwords are typed only in Plaid's window and the bank's own login page; yomi stores only the access token Plaid issues, encrypted on your computer. yomi reads data only; it cannot move money or trade.

## Plans and limits

Plaid's terms change; check [Plaid's pricing page](https://plaid.com/pricing/) and [billing docs](https://plaid.com/docs/account/billing/) for current limits. As read on the billing docs on 2026-09-30:

| | Sandbox | Trial plan | Paid Production |
|---|---|---|---|
| Cost | Free | Free | Paid |
| Data | Fake test banks | Real data (Production environment) | Real data |
| Who | Anyone | New US or Canada teams created on or after 2026-04-15 | See Plaid |
| Limit | Test only | 10 Production Items (bank logins) in total | See Plaid |

On the Trial plan, a disconnected Item's slot is **not** returned. Connect each bank once, and use **Pause** rather than **Disconnect** when you only want to stop syncing. In yomi each bank or brokerage login uses one Item.

## Get your keys

These steps match the in-app guide under Settings > Connections > Developer keys.

1. Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com/) and confirm your email.
2. Open [Developers > Keys](https://dashboard.plaid.com/developers/keys) and copy the **client ID** and the **Sandbox secret**. The client ID is shared by all environments; each environment has its own secret. Sandbox works right away with test banks.
3. For real banks, request Production access through the [Trial plan](https://dashboard.plaid.com/trial-plan). The **Production secret** then appears on the same Keys page.
4. Make sure **Transactions** and **Investments** are enabled under [Products](https://dashboard.plaid.com/settings/team/products); request Investments there if it is missing. yomi asks banks for Transactions and brokerages for Investments.
5. OAuth banks (Bank of America, Chase and others) need your company profile filled in under the Dashboard's Compliance section; Bank of America refuses apps with an empty profile. In a desktop browser Plaid opens the bank in a pop-up, so no redirect URI is needed ([Plaid OAuth guide](https://plaid.com/docs/link/oauth/)).

## Enter the keys in yomi

Either place works. An environment variable wins over Settings, field by field.

**Settings:** open Settings > Connections, expand **Developer keys**, paste the client ID and one or both secrets, click **Test keys** for each environment, then save. Saved keys take effect without a restart. The first save creates a key file (see [Security](#security)).

**Environment:** add to `.env.local` at the repository root and restart `pnpm dev`:

```
PLAID_CLIENT_ID=...
PLAID_SECRET_SANDBOX=...
PLAID_SECRET_PRODUCTION=...
PLAID_ENV=production          # optional: where new connections go by default
```

- At least one secret is required. With both, each connection uses the secret of its own environment, so there is no switching back and forth.
- `PLAID_ENV` only picks the default for new connections. When unset, Production is used if it has a secret, otherwise Sandbox.
- The older single `PLAID_SECRET` still works: it counts as the secret for the environment `PLAID_ENV` names (Sandbox when unset), unless a specific `PLAID_SECRET_<ENVIRONMENT>` is set.
- Fields set in the environment show as "Set by environment" in Settings and cannot be edited there.

## Connect

1. Open Settings > Connections.
2. Click **Connect bank** (or **Connect brokerage** for Robinhood and other US brokerages). With both environments configured, the menu next to the buttons offers "Connect a test bank (Sandbox)" or "Connect a real bank".
3. Pick your bank in Plaid's window and log in. OAuth banks open their own login page in a pop-up.
4. yomi saves the connection and runs a first sync. It asks for up to two years of history. Plaid often has no data ready right after a login; yomi retries every 10 minutes until it arrives, or click **Sync now** after a minute or two.

**Sandbox:** in Plaid's window, log in with `user_good` / `pass_good` ([Plaid Sandbox docs](https://plaid.com/docs/sandbox/)). Sandbox transactions are written into the current ledger. To try the flow without touching your real ledger, start yomi on a scratch database first, for example `DATABASE_URL=data/scratch-pglite pnpm dev`. Background sync is off on any ledger other than the default `data/pglite` (set `YOMI_BACKGROUND_SYNC=1` to turn it on); **Sync now** always works.

## What gets synced

| | Banks (Transactions) | Brokerages (Investments) |
|---|---|---|
| When | At startup, then every 6 hours, plus **Sync now** | Once per trading day after the US close (18:00 New York), catching up at startup, plus **Sync now** on the Assets page |
| What | Posted transactions only; pending ones are skipped and arrive when they post | Holdings, cash and recent investment transactions, shown on the Assets page |
| Where | The ledger, as an import batch under Import history | Assets only, not the ledger |

Bank transactions go through the same pipeline as statement files: dedup by Plaid transaction ID, categories, automatic split rules, and linking a card row to the Alipay or WeChat row paid with that card (same last four digits, amount and currency, within 3 days). Bank of America rows are also linked to rows from a [Bank of America CSV](import-boa.md) import. When the bank later changes or removes a transaction, yomi follows, unless you split, settled or edited that row; then it keeps your version and shows a notice.

## Connection states

- **Needs attention:** the bank wants a new login (for example `ITEM_LOGIN_REQUIRED`). Click **Reconnect** and log in again in Plaid's window. Reconnecting does not use a new Item.
- **Paused:** no automatic or manual syncs; the Item and its slot are kept. **Resume** continues where it stopped.
- **Disconnect…:** calls Plaid's `/item/remove`, which invalidates the token, then forgets it locally. You type the connection's name to confirm. Synced transactions and holdings stay. The Trial slot is not returned. If the secret for that connection's environment is not configured, the connection is only forgotten locally and still exists at Plaid.

## Security

- Access tokens (and Plaid keys saved in Settings) are stored encrypted with AES-256-GCM. The key comes from `YOMI_SECRET_KEY` when set, otherwise from the key file `~/.config/yomi/secret.key` (or `$XDG_CONFIG_HOME/yomi/secret.key`, or the path in `YOMI_SECRET_KEY_FILE`), which yomi creates the first time you save a secret in Settings.
- If you use only `.env.local` and have no key yet, tokens are stored unencrypted and Settings > Connections says so. Generate a key with `pnpm secrets:gen-key`, set `YOMI_SECRET_KEY` in `.env.local`, and restart: existing tokens are encrypted in place after a backup.
- Back up the key file or `YOMI_SECRET_KEY` in a password manager. Without it, stored tokens cannot be decrypted and you must reconnect, which uses new Trial slots.
- The key sits on the same disk as the ledger, so this protects a leaked database or backup file, not a compromised computer. See [Configuration](configuration.md#credentials-and-encryption) for scrubbing old backups.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| "Plaid is not set up yet" | Client ID or every secret is missing. Add them in Developer keys or `.env.local`. |
| Test keys: `INVALID_API_KEYS` | Wrong secret for that environment, or a client ID from another team. Copy both again from Keys. |
| Bank of America refuses the app | Fill in the company profile under Compliance in the Plaid Dashboard. |
| No transactions after connecting | Plaid is still preparing the first pull. Wait a few minutes; yomi retries every 10 minutes. |
| A Sandbox connection never syncs | `PLAID_SECRET_SANDBOX` (or the saved Sandbox secret) was removed. Add it back. |
| "YOMI_SECRET_KEY is missing or wrong" | The key changed or the key file is gone. Restore the original key and restart; nothing was deleted. |
| Bank login finished but no connection appeared | yomi recovers unfinished logins from Plaid every 10 minutes while Plaid's temporary token is valid. If it never appears, send the `link_session_id` shown in the message to [Plaid support](https://dashboard.plaid.com/support). |

See also: [Bank of America CSV guide](import-boa.md), [Interactive Brokers guide](ibkr.md).
