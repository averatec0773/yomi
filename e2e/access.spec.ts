import { expect, test } from "./fixtures";
import { ACCESS_E2E_PORT, ACCESS_E2E_TOKEN } from "../playwright.config";

// Runs against the second webServer (YOMI_ACCESS_TOKEN set). The main server has the gate off.
const base = `http://localhost:${ACCESS_E2E_PORT}`;
test.use({ baseURL: base });

test("the gate: redirects, 401s, bearer, token once, form, sign out", async ({ page, request }) => {
  const noRedirect = { maxRedirects: 0 } as const;

  const page1 = await request.get("/analysis?preset=this-month", noRedirect);
  expect(page1.status()).toBe(307);
  expect(page1.headers().location).toContain(`/access?next=${encodeURIComponent("/analysis?preset=this-month")}`);

  const api = await request.get("/api/participants", noRedirect);
  expect(api.status()).toBe(401);
  expect(await api.json()).toEqual({ error: "Access token required", code: "access_required" });

  const bearer = await request.get("/api/participants", { headers: { Authorization: `Bearer ${ACCESS_E2E_TOKEN}` } });
  expect(bearer.status()).toBe(200);
  const wrongBearer = await request.get("/api/participants", { headers: { Authorization: "Bearer nope" } });
  expect(wrongBearer.status()).toBe(401);

  const wrongOnce = await request.get("/analysis?token=nope", noRedirect);
  expect(wrongOnce.status()).toBe(307);
  expect(wrongOnce.headers().location).toContain(`/access?next=${encodeURIComponent("/analysis")}`);
  expect(wrongOnce.headers()["set-cookie"]).toBeUndefined();
  const once = await request.get(`/analysis?preset=this-month&token=${ACCESS_E2E_TOKEN}`, noRedirect);
  expect(once.status()).toBe(307);
  expect(once.headers().location).toMatch(/\/analysis\?preset=this-month$/);
  expect(once.headers()["set-cookie"]).toMatch(/^yomi_access=[0-9a-f]{64}; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax$/);
  // The request context now holds the cookie: the API answers without a bearer.
  expect((await request.get("/api/participants")).status()).toBe(200);

  // Token once in the URL: cookie set, token stripped, then the cookie alone is enough.
  await page.goto(`/transactions?token=${ACCESS_E2E_TOKEN}`);
  await expect(page).toHaveURL(`${base}/transactions`);
  const cookie = (await page.context().cookies()).find((c) => c.name === "yomi_access");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  expect(cookie?.value).not.toContain(ACCESS_E2E_TOKEN);
  await page.goto("/settings?tab=security");
  await expect(page.getByTestId("settings-security")).toContainText("Access token");

  // Sign out on this device, then the form: a wrong token stays, the right one returns to next.
  await page.getByRole("button", { name: "Sign out on this device" }).click();
  await expect(page).toHaveURL(/\/access\?next=%2Fsettings%3Ftab%3Dsecurity$/);
  await page.getByLabel("Access token").fill("wrong-token");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("access-form").getByRole("alert")).toHaveText("That access token is not right.");
  await page.getByLabel("Access token").fill(ACCESS_E2E_TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(`${base}/settings?tab=security`);
});

test("a foreign Host is refused before the gate, even with a valid bearer; health stays open for readiness", async ({ request }) => {
  const host = { host: `rebind.example:${ACCESS_E2E_PORT}` };
  const page = await request.get("/transactions", { headers: host, maxRedirects: 0 });
  expect(page.status()).toBe(403);
  expect(await page.json()).toMatchObject({ code: "request_host_not_allowed" });
  const api = await request.get("/api/participants", { headers: { ...host, Authorization: `Bearer ${ACCESS_E2E_TOKEN}` } });
  expect(api.status()).toBe(403);
  expect((await request.get("/api/health", { headers: host })).status()).toBe(200);
});
