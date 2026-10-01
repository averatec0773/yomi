import { describe, expect, it } from "vitest";
import { getCurrentUser, runWithUser } from "../user";
import {
  accessCookieHeader,
  accessCookieValue,
  type AccessRequest,
  clearAccessCookieHeader,
  cookieMatches,
  decideAccess,
  readAccessToken,
  safeNextPath,
} from "./index";

const TOKEN = "s3cret-token";
const good = accessCookieValue(TOKEN);

function req(over: Partial<AccessRequest>): AccessRequest {
  return { token: TOKEN, cookie: null, bearer: null, path: "/transactions", search: "", method: "GET", ...over };
}

describe("readAccessToken", () => {
  it("is null when unset or blank, trimmed otherwise", () => {
    expect(readAccessToken({})).toBeNull();
    expect(readAccessToken({ YOMI_ACCESS_TOKEN: "" })).toBeNull();
    expect(readAccessToken({ YOMI_ACCESS_TOKEN: "   " })).toBeNull();
    expect(readAccessToken({ YOMI_ACCESS_TOKEN: "  abc \n" })).toBe("abc");
  });
});

describe("decideAccess", () => {
  it("allows everything when the token is unset", () => {
    for (const path of ["/transactions", "/api/transactions", "/settings"]) {
      expect(decideAccess(req({ token: null, path }))).toEqual({ kind: "allow" });
    }
    expect(decideAccess(req({ token: null, method: "POST", path: "/api/quick" }))).toEqual({ kind: "allow" });
  });

  it("allows a valid cookie on pages and API", () => {
    expect(decideAccess(req({ cookie: good }))).toEqual({ kind: "allow" });
    expect(decideAccess(req({ cookie: good, path: "/api/transactions", method: "POST" }))).toEqual({ kind: "allow" });
  });

  it("never stores the token itself in the cookie", () => {
    expect(good).toMatch(/^[0-9a-f]{64}$/);
    expect(good).not.toContain(TOKEN);
    expect(decideAccess(req({ cookie: TOKEN }))).toMatchObject({ kind: "redirect-to-access" });
  });

  it("accepts a bearer token on /api only", () => {
    expect(decideAccess(req({ bearer: TOKEN, path: "/api/month" }))).toEqual({ kind: "allow" });
    expect(decideAccess(req({ bearer: "nope", path: "/api/month" }))).toEqual({ kind: "unauthorized" });
    expect(decideAccess(req({ bearer: TOKEN, path: "/transactions" }))).toMatchObject({ kind: "redirect-to-access" });
  });

  it("round-trips a query token: set cookie, redirect without the param, then the cookie is enough", () => {
    const first = decideAccess(req({ path: "/stats", search: "?preset=this-month&token=s3cret-token" }));
    expect(first).toEqual({ kind: "set-cookie-and-redirect", location: "/stats?preset=this-month" });
    expect(decideAccess(req({ path: "/", search: "token=s3cret-token" }))).toEqual({ kind: "set-cookie-and-redirect", location: "/" });
    const cookie = /yomi_access=([0-9a-f]+);/.exec(accessCookieHeader(TOKEN, false))?.[1] ?? null;
    expect(decideAccess(req({ path: "/stats", search: "?preset=this-month", cookie }))).toEqual({ kind: "allow" });
  });

  it("does not accept a query token on /api", () => {
    expect(decideAccess(req({ path: "/api/month", search: "?token=s3cret-token" }))).toEqual({ kind: "unauthorized" });
  });

  it("exempts the access page, its API, health and static assets", () => {
    for (const path of ["/access", "/api/access", "/api/health", "/_next/static/chunks/a.js", "/favicon.ico"]) {
      expect(decideAccess(req({ path }))).toEqual({ kind: "allow" });
    }
    expect(decideAccess(req({ path: "/accessories" }))).toMatchObject({ kind: "redirect-to-access" });
    expect(decideAccess(req({ path: "/api/access-log" }))).toEqual({ kind: "unauthorized" });
  });

  it("rejects a wrong token: pages go to /access with next (token param dropped), API gets 401", () => {
    expect(decideAccess(req({ path: "/split", search: "?p=2&token=wrong" }))).toEqual({
      kind: "redirect-to-access",
      location: `/access?next=${encodeURIComponent("/split?p=2")}`,
    });
    expect(decideAccess(req({ cookie: accessCookieValue("wrong") }))).toMatchObject({ kind: "redirect-to-access" });
    expect(decideAccess(req({ path: "/api/transactions", cookie: accessCookieValue("wrong") }))).toEqual({ kind: "unauthorized" });
    expect(decideAccess(req({ method: "POST" }))).toEqual({ kind: "unauthorized" });
  });

  it("rejects an empty presented token", () => {
    expect(decideAccess(req({ search: "?token=" }))).toMatchObject({ kind: "redirect-to-access" });
    expect(decideAccess(req({ path: "/api/month", bearer: "" }))).toEqual({ kind: "unauthorized" });
    expect(decideAccess(req({ cookie: "" }))).toMatchObject({ kind: "redirect-to-access" });
    expect(cookieMatches(TOKEN, "zz")).toBe(false);
  });
});

describe("cookie headers and next", () => {
  it("sets HttpOnly, SameSite=Lax, a year, Secure only over https", () => {
    expect(accessCookieHeader(TOKEN, false)).toBe(`yomi_access=${good}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    expect(accessCookieHeader(TOKEN, true)).toMatch(/; Secure$/);
    expect(clearAccessCookieHeader(false)).toBe("yomi_access=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  });

  it("keeps next to same-origin paths", () => {
    expect(safeNextPath("/stats?preset=x")).toBe("/stats?preset=x");
    for (const bad of [null, "", "https://evil.test/", "//evil.test", "/\\evil.test", "stats", "/access?next=%2F", "/\t/evil.test"]) expect(safeNextPath(bad)).toBe("/");
  });
});

describe("runWithUser", () => {
  it("scopes the acting user and falls back to the LOCAL_MODE user outside", async () => {
    expect(getCurrentUser()).toEqual({ id: 1 });
    const seen = await runWithUser({ id: 7 }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getCurrentUser();
    });
    expect(seen).toEqual({ id: 7 });
    expect(getCurrentUser()).toEqual({ id: 1 });
  });
});
