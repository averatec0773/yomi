import type { ApiError } from "@yomi/contracts";
import type { MiddlewareHandler } from "hono";

/** Host names every install answers to, on the port it runs on. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** "localhost:7773" → { name: "localhost", port: "7773" }, "[::1]" → { name: "[::1]", port: "" }; null when malformed. */
function parseHost(value: string): { name: string; port: string } | null {
  const m = /^(\[[0-9a-f:.]+\]|[^\s:/[\]@]+)(?::(\d+))?$/i.exec(value.trim());
  return m ? { name: m[1]!.toLowerCase(), port: m[2] ?? "" } : null;
}

/** YOMI_ALLOWED_HOSTS: comma-separated names this server also answers to, each with an optional port ("my-laptop,192.168.1.20:7773"). */
export function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.YOMI_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * Whether `value` (a Host header, or the host of an Origin) names this server: a loopback name or an allowed one, on
 * the entry's port when it names one, else on the server's own port (or none, behind a proxy on 80/443).
 */
export function hostAllowed(value: string, serverPort: string, allowed: readonly string[]): boolean {
  const h = parseHost(value);
  if (!h) return false;
  return [...LOOPBACK, ...allowed].some((entry) => {
    const e = parseHost(entry);
    return e !== null && e.name === h.name && (e.port ? h.port === e.port : h.port === "" || h.port === serverPort);
  });
}

function originAllowed(origin: string, serverPort: string, allowed: readonly string[]): boolean {
  try {
    return hostAllowed(new URL(origin).host, serverPort, allowed);
  } catch {
    return false; // "null" (sandboxed frames, file pages) and anything unparsable
  }
}

/**
 * Refuses requests this server's own pages could not have sent. The Host must name this server, which stops DNS
 * rebinding (a page on another name that resolves to this computer). A browser request must come from this origin:
 * `Sec-Fetch-Site` other than same-origin (or none, typed by the user) and an `Origin` that is not this server mark a
 * page on another site posting here, which the access cookie (SameSite=Lax) alone does not cover when the gate is off.
 * Scripts on this computer (curl, no Origin) pass. `serverPort` comes from the request URL, which Next.js builds from
 * its own listening origin.
 */
export function sameOriginOnly(allowed: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const host = c.req.header("host") ?? url.host;
    if (!hostAllowed(host, url.port, allowed)) {
      const body: ApiError = {
        error: `This server does not answer to ${host}. Add it to YOMI_ALLOWED_HOSTS and restart yomi`,
        code: "request_host_not_allowed",
        params: { host },
      };
      return c.json(body, 403);
    }
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if ((site !== undefined && site !== "same-origin" && site !== "none") || (origin !== undefined && !originAllowed(origin, url.port, allowed))) {
      return c.json({ error: "Requests from other sites are refused", code: "request_cross_site" } satisfies ApiError, 403);
    }
    await next();
  };
}
