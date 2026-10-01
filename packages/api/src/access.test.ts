import { ParticipantList } from "@yomi/contracts";
import { accessCookieValue, getCurrentUser, seed } from "@yomi/core";
import { testDb } from "@yomi/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "./index";

async function setup(resolveUser?: () => { id: number }) {
  const db = await testDb();
  await seed(db);
  return createApi({ getDb: () => db, resolveUser });
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => vi.unstubAllEnvs());

describe("request-scoped user", () => {
  it("runs each request as the resolved user and leaves the fallback outside", async () => {
    const own = await (await setup()).request("/api/participants");
    expect(ParticipantList.parse(await own.json()).participants.some((p) => p.isSelf)).toBe(true);

    const other = await (await setup(() => ({ id: 2 }))).request("/api/participants");
    expect(other.status).toBe(200);
    expect(ParticipantList.parse(await other.json()).participants).toEqual([]);
    expect(getCurrentUser()).toEqual({ id: 1 });
  });
});

describe("/api/access", () => {
  it("is a no-op without YOMI_ACCESS_TOKEN: no cookie", async () => {
    vi.stubEnv("YOMI_ACCESS_TOKEN", "");
    const res = await (await setup()).request("/api/access", json({ token: "anything" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, gate: false });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sets the hashed cookie for the right token and 401s a wrong one", async () => {
    vi.stubEnv("YOMI_ACCESS_TOKEN", " tok-3141 ");
    const app = await setup();
    const ok = await app.request("/api/access", json({ token: "tok-3141" }));
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toContain(`yomi_access=${accessCookieValue("tok-3141")}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("tok-3141");

    const https = await app.request("https://yomi.test/api/access", json({ token: "tok-3141" }));
    expect(https.headers.get("set-cookie")).toContain("Secure");

    const bad = await app.request("/api/access", json({ token: "tok-5501" }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ code: "access_invalid" });
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("DELETE clears the cookie", async () => {
    vi.stubEnv("YOMI_ACCESS_TOKEN", "tok-3141");
    const res = await (await setup()).request("/api/access", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^yomi_access=; Path=\/; Max-Age=0/);
  });
});
