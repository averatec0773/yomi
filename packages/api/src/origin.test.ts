import { ApiError } from "@yomi/contracts";
import { seed } from "@yomi/core";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

async function setup(allowedHosts: string[] = []) {
  const db = await testDb();
  await seed(db);
  const app = createApi({ getDb: () => db, allowedHosts });
  // Next.js hands the route its own listening origin as the URL; the headers are what the client sent.
  const send = (method: string, headers: Record<string, string> = {}) =>
    app.request("http://localhost:7773/api/settings/shortcuts", {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: method === "GET" ? undefined : JSON.stringify({ overrides: {} }),
    });
  return { app, send };
}

async function code(res: Response): Promise<string> {
  return ApiError.parse(await res.json()).code!;
}

describe("same-origin guard on /api", () => {
  it("lets the app's own requests and local scripts through", async () => {
    const { send } = await setup();
    // curl or a script on this computer: no Origin, no Sec-Fetch-Site.
    expect((await send("PUT", { host: "localhost:7773" })).status).toBe(200);
    expect((await send("PUT", { host: "127.0.0.1:7773" })).status).toBe(200);
    expect((await send("GET", { host: "[::1]:7773" })).status).toBe(200);
    // The web app's own fetch.
    expect((await send("PUT", { host: "localhost:7773", origin: "http://localhost:7773", "sec-fetch-site": "same-origin" })).status).toBe(200);
    // A link the user opened by hand (a CSV download typed into the address bar).
    expect((await send("GET", { host: "localhost:7773", "sec-fetch-site": "none" })).status).toBe(200);
  });

  it("refuses a Host this server does not answer to (DNS rebinding), with a code the UI translates", async () => {
    const { send } = await setup();
    const res = await send("GET", { host: "rebind.evil.example:7773" });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("request_host_not_allowed");
    expect((await send("PUT", { host: "192.168.1.20:7773" })).status).toBe(403);
  });

  it("refuses requests sent by pages on another site or another local port", async () => {
    const { send } = await setup();
    const crossSite = await send("PUT", { host: "localhost:7773", "sec-fetch-site": "cross-site", origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(await code(crossSite)).toBe("request_cross_site");
    // localhost:3000 and localhost:7773 are the same site but not the same origin.
    expect((await send("PUT", { host: "localhost:7773", "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await send("PUT", { host: "localhost:7773", origin: "http://localhost:3000" })).status).toBe(403);
    expect((await send("PUT", { host: "localhost:7773", origin: "null" })).status).toBe(403);
    // A cross-site GET (an <img> or a link on another site) is refused too.
    expect((await send("GET", { host: "localhost:7773", "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("serves the names listed in YOMI_ALLOWED_HOSTS, for both Host and Origin", async () => {
    const { send } = await setup(["192.168.1.20", "my-laptop.tail1234.ts.net"]);
    expect((await send("PUT", { host: "192.168.1.20:7773", origin: "http://192.168.1.20:7773", "sec-fetch-site": "same-origin" })).status).toBe(200);
    // Behind Tailscale Serve (HTTPS on 443): no port in Host or Origin.
    expect((await send("PUT", { host: "my-laptop.tail1234.ts.net", origin: "https://my-laptop.tail1234.ts.net" })).status).toBe(200);
    expect((await send("PUT", { host: "192.168.1.20:7773", origin: "http://evil.example" })).status).toBe(403);
  });

  it("keeps /api/health open to any host (container health checks)", async () => {
    const { app } = await setup();
    expect((await app.request("http://localhost:7773/api/health", { headers: { host: "yomi:7773" } })).status).toBe(200);
  });
});
