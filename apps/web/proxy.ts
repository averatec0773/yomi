import { ACCESS_COOKIE, accessCookieHeader, allowedHostsFromEnv, decideAccess, hostRefusal, readAccessToken } from "@yomi/core/access";
import { type NextRequest, NextResponse } from "next/server";

/**
 * First the Host allowlist, on every request but the /api/health probe: a page on another name that resolves to this
 * computer (DNS rebinding) must not read server-rendered pages. Then the optional access token gate
 * (YOMI_ACCESS_TOKEN); with the variable unset every allowed request passes untouched. Both decisions live in
 * @yomi/core/access; this file only reads the request and writes the response. Localhost is deliberately not exempt
 * from the gate: the Host header is client-controlled, so a LAN client could claim to be localhost.
 */
export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  if (url.pathname !== "/api/health") {
    const refusal = hostRefusal(request.headers.get("host"), new URL(request.url), allowedHostsFromEnv());
    if (refusal) return NextResponse.json(refusal, { status: 403 });
  }

  const token = readAccessToken();
  if (token === null) return NextResponse.next();

  const auth = request.headers.get("authorization");
  const decision = decideAccess({
    token,
    cookie: request.cookies.get(ACCESS_COOKIE)?.value ?? null,
    bearer: auth?.startsWith("Bearer ") ? auth.slice(7) : null,
    path: url.pathname,
    search: url.search,
    method: request.method,
  });

  switch (decision.kind) {
    case "allow":
      return NextResponse.next();
    case "set-cookie-and-redirect": {
      const res = NextResponse.redirect(new URL(decision.location, request.url));
      const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
      res.headers.append("Set-Cookie", accessCookieHeader(token, (forwarded ?? url.protocol.replace(":", "")) === "https"));
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
    case "redirect-to-access":
      return NextResponse.redirect(new URL(decision.location, request.url));
    case "unauthorized":
      return NextResponse.json({ error: "Access token required", code: "access_required" }, { status: 401 });
  }
}

export const config = {
  // Static build output never needs the gate; everything else (pages, /api, server actions) goes through decideAccess.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
