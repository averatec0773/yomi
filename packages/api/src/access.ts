import { AccessInput, type AccessResult, type ApiError } from "@yomi/contracts";
import { accessCookieHeader, clearAccessCookieHeader, readAccessToken, tokenMatches } from "@yomi/core";
import { type Context, Hono } from "hono";
import { readJson, withSplitErrors } from "./split";

function isHttps(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  return (forwarded ?? new URL(c.req.url).protocol.replace(":", "")) === "https";
}

/**
 * Routes: POST /access (token in, access cookie out), DELETE /access (sign out on this device). Exempt from the
 * access gate in apps/web/proxy.ts, which does the per-request check.
 */
export function accessRoutes(): Hono {
  const r = withSplitErrors(new Hono());

  r.post("/access", async (c) => {
    const { token: presented } = await readJson(c, AccessInput);
    const token = readAccessToken();
    if (token === null) return c.json({ ok: true, gate: false } satisfies AccessResult);
    if (!tokenMatches(token, presented)) {
      return c.json({ error: "That access token is not right", code: "access_invalid" } satisfies ApiError, 401);
    }
    c.header("Set-Cookie", accessCookieHeader(token, isHttps(c)));
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, gate: true } satisfies AccessResult);
  });

  r.delete("/access", (c) => {
    c.header("Set-Cookie", clearAccessCookieHeader(isHttps(c)));
    return c.json({ ok: true, gate: readAccessToken() !== null } satisfies AccessResult);
  });

  return r;
}
