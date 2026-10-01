import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Optional access token gate (YOMI_ACCESS_TOKEN). Framework-free: apps/web/proxy.ts and the /api/access routes call
 * these. The cookie holds the SHA-256 hex of the token, never the token itself.
 */

export const ACCESS_COOKIE = "yomi_access";
export const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
export const ACCESS_PAGE = "/access";

/** YOMI_ACCESS_TOKEN, trimmed; null when unset or blank (gate off). Read per call so a restart is the only change needed. */
export function readAccessToken(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.YOMI_ACCESS_TOKEN?.trim();
  return token ? token : null;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The cookie value for a token: its SHA-256 hex. */
export function accessCookieValue(token: string): string {
  return sha256(token).toString("hex");
}

/** A presented token (query or bearer) matches, compared in constant time over the hashes. */
export function tokenMatches(token: string, presented: string | null | undefined): boolean {
  if (!presented) return false;
  return timingSafeEqual(sha256(token), sha256(presented.trim()));
}

/** A cookie value matches the token's hash, compared in constant time. */
export function cookieMatches(token: string, cookie: string | null | undefined): boolean {
  if (!cookie || !/^[0-9a-f]{64}$/.test(cookie)) return false;
  return timingSafeEqual(Buffer.from(cookie, "hex"), sha256(token));
}

/** Paths that never need the cookie: the access page and its API, health, and Next static assets. */
export function isExemptPath(path: string): boolean {
  return (
    path === ACCESS_PAGE ||
    path === "/api/access" ||
    path === "/api/health" ||
    path === "/favicon.ico" ||
    path.startsWith("/_next/")
  );
}

/** Set-Cookie header value for a valid token. `Secure` only over https, so plain-http LAN/Tailscale access still works. */
export function accessCookieHeader(token: string, secure: boolean): string {
  return [
    `${ACCESS_COOKIE}=${accessCookieValue(token)}`,
    "Path=/",
    `Max-Age=${ACCESS_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Set-Cookie header value that removes the access cookie. */
export function clearAccessCookieHeader(secure: boolean): string {
  return [`${ACCESS_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : [])].join("; ");
}

/** A same-origin path to return to after /access; anything else (absolute URL, //host, backslashes, /access) becomes "/". */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || [...next].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return "/";
  if (new URL(next, "http://x").pathname === ACCESS_PAGE) return "/";
  return next;
}

export interface AccessRequest {
  /** readAccessToken(); null means the gate is off. */
  token: string | null;
  /** The yomi_access cookie value, if any. */
  cookie: string | null;
  /** The value after "Bearer " in the Authorization header, if any. */
  bearer: string | null;
  /** URL pathname. */
  path: string;
  /** URL query string, with or without the leading "?" (may carry ?token=). */
  search: string;
  method: string;
}

export type AccessDecision =
  | { kind: "allow" }
  /** Valid ?token= on a page: set the cookie and redirect to `location` (the same URL without the token param). */
  | { kind: "set-cookie-and-redirect"; location: string }
  /** A page without access: redirect to `location` (/access?next=...). */
  | { kind: "redirect-to-access"; location: string }
  /** An API call (or a non-GET page request) without access: 401 JSON. */
  | { kind: "unauthorized" };

function withoutToken(path: string, params: URLSearchParams): string {
  const rest = new URLSearchParams(params);
  rest.delete("token");
  const qs = rest.toString();
  return qs ? `${path}?${qs}` : path;
}

export function decideAccess(req: AccessRequest): AccessDecision {
  const { token } = req;
  if (token === null || isExemptPath(req.path)) return { kind: "allow" };

  const isApi = req.path === "/api" || req.path.startsWith("/api/");
  const isNavigation = req.method === "GET" || req.method === "HEAD";
  const params = new URLSearchParams(req.search);

  if (isApi) {
    if (tokenMatches(token, req.bearer) || cookieMatches(token, req.cookie)) return { kind: "allow" };
    return { kind: "unauthorized" };
  }

  const queryToken = params.get("token");
  if (isNavigation && queryToken !== null && tokenMatches(token, queryToken)) {
    return { kind: "set-cookie-and-redirect", location: withoutToken(req.path, params) };
  }
  if (cookieMatches(token, req.cookie)) return { kind: "allow" };
  if (!isNavigation) return { kind: "unauthorized" };
  return { kind: "redirect-to-access", location: `${ACCESS_PAGE}?next=${encodeURIComponent(withoutToken(req.path, params))}` };
}
