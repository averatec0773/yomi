import type { ApiError } from "@yomi/contracts";
import { hostAllowed, hostRefusal } from "@yomi/core";
import type { MiddlewareHandler } from "hono";

function originAllowed(origin: string, serverPort: string, allowed: readonly string[]): boolean {
  try {
    return hostAllowed(new URL(origin).host, serverPort, allowed);
  } catch {
    return false; // "null" (sandboxed frames, file pages) and anything unparsable
  }
}

/**
 * Refuses requests this server's own pages could not have sent. The Host must name this server (hostRefusal in
 * @yomi/core, which apps/web/proxy.ts also applies to pages), which stops DNS rebinding. A browser request must come
 * from this origin: `Sec-Fetch-Site` other than same-origin (or none, typed by the user) and an `Origin` that is not
 * this server mark a page on another site posting here, which the access cookie (SameSite=Lax) alone does not cover
 * when the gate is off. Scripts on this computer (curl, no Origin) pass. `serverPort` comes from the request URL,
 * which Next.js builds from its own listening origin.
 */
export function sameOriginOnly(allowed: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const refusal = hostRefusal(c.req.header("host"), url, allowed);
    if (refusal) return c.json(refusal satisfies ApiError, 403);
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if ((site !== undefined && site !== "same-origin" && site !== "none") || (origin !== undefined && !originAllowed(origin, url.port, allowed))) {
      return c.json({ error: "Requests from other sites are refused", code: "request_cross_site" } satisfies ApiError, 403);
    }
    await next();
  };
}
