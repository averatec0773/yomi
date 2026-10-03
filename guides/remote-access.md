# Open yomi from your phone (LAN or Tailscale)

Last checked: 2026-10-02

yomi runs on one computer, but the web app works on a phone too: the Transactions list, the Split popover and Add (quick entry) are built for small screens. This guide shows how to reach it from other devices safely, either on your home network or from anywhere with [Tailscale](https://tailscale.com).

## First, turn on the access token

`pnpm dev` listens on port 7773 (change it with `PORT`) on every network interface of the computer, so other devices on the same network can open it. Without a token, anyone who can reach the address can read and change your ledger. Set a token before you open yomi from anything but this computer.

1. Generate a long random token:

   ```bash
   openssl rand -hex 32
   ```

2. Add it to `.env.local` at the repository root (create the file from `.env.example` if you do not have one):

   ```
   YOMI_ACCESS_TOKEN=<the token>
   ```

3. Restart `pnpm dev`. Settings > Security now shows **Access token: On**.

From now on every browser, including the one on this computer, enters the token once:

- Open `http://<host>:7773/?token=<the token>` once. yomi stores an access cookie for a year and removes the token from the address bar.
- Or open `http://<host>:7773/` and type the token on the **Access** page.

The cookie holds a hash of the token, never the token itself. **Sign out on this device** in Settings > Security removes it. To change the token for every device, edit `YOMI_ACCESS_TOKEN` and restart; old cookies stop working. Scripts can call the API with `Authorization: Bearer <the token>` instead of a cookie.

## Then, list the addresses you will use

Until you list other names, yomi's API answers only to `localhost`, `127.0.0.1` and `[::1]`, so a web page on another site cannot reach your ledger by pointing its own domain at this computer (DNS rebinding). Add every address you will type on another device to `.env.local`, separated by commas:

```
YOMI_ALLOWED_HOSTS=192.168.1.20,my-laptop,my-laptop.tail1234.ts.net
```

Restart `pnpm dev`. A name without a port matches yomi's own port, and addresses with no port at all (an HTTPS proxy such as Tailscale Serve). Add `:port` when the browser uses a different port than the one yomi listens on, for example `localhost:8080` for a Docker port mapping.

## On your home network (LAN)

1. Find the computer's local address. On macOS: System Settings > Wi-Fi > Details; on Linux: `ip addr`; on Windows: `ipconfig`. It looks like `192.168.1.20`.
2. Add that address to `YOMI_ALLOWED_HOSTS` ([above](#then-list-the-addresses-you-will-use)) and restart `pnpm dev`.
3. On the phone, connected to the same Wi-Fi, open `http://192.168.1.20:7773/?token=<the token>`.
4. If the page does not load, the computer's firewall may block incoming connections to Node.js; allow them for private networks.

Traffic on a LAN is plain HTTP. That is acceptable on a home network you trust, not on shared or public Wi-Fi; use Tailscale there.

## From anywhere with Tailscale

[Tailscale](https://tailscale.com) puts your devices on a private, encrypted network, so the phone reaches the computer without opening any port to the internet.

1. [Install Tailscale](https://tailscale.com/download) on the computer that runs yomi and on your phone, and sign in to the same account on both ([install guide](https://tailscale.com/kb/1017/install)).
2. Find the computer's Tailscale name or address in the Tailscale app or admin console: a `100.x.y.z` address, or a name such as `my-laptop` when [MagicDNS](https://tailscale.com/kb/1081/magicdns) is on.
3. Add the name or address to `YOMI_ALLOWED_HOSTS` ([above](#then-list-the-addresses-you-will-use)) and restart `pnpm dev`. With Tailscale Serve, add the full HTTPS name too (`my-laptop.tail1234.ts.net`).
4. On the phone, with Tailscale connected, open `http://my-laptop:7773/?token=<the token>` (or the `100.x.y.z` address).
5. Optional: for HTTPS, Tailscale can proxy the port with its [Serve feature](https://tailscale.com/kb/1312/serve). When the proxy reports HTTPS (`X-Forwarded-Proto: https`), yomi marks the access cookie `Secure`. Check Tailscale's docs for the current command.

Tailscale menu names and commands change between versions; the links above go to Tailscale's own documentation.

## What stays on the computer

- The ledger, backups and credentials stay on the computer running yomi; the phone only shows pages.
- The computer must be on and `pnpm dev` running for the phone to reach it.
- Background bank sync runs on the computer, not the phone.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| The phone shows the Access page again and again | The token in the address or typed on the page does not match `YOMI_ACCESS_TOKEN` (check for spaces), or the browser blocks cookies for this site. |
| "yomi does not answer to … yet" (`403 request_host_not_allowed`) | Add that address, exactly as the browser shows it, to `YOMI_ALLOWED_HOSTS` in `.env.local` and restart. |
| `401 access_required` from a script | Send `Authorization: Bearer <the token>`. |
| The page does not load at all | Same network (or Tailscale connected) on both devices? Firewall allowing Node.js? Is `pnpm dev` still running? |
| "Secrets can be saved only on this computer (localhost) or over HTTPS" | Credentials are entered on the computer itself (http://localhost:7773) or over HTTPS (for example Tailscale Serve), never over plain HTTP on the network. |
| Settings > Security says the token is off | `.env.local` is not at the repository root, or yomi was not restarted after editing it. |
