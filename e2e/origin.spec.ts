import { expect, test } from "./fixtures";

// The main server's port, from playwright.config.ts (baseURL).
const PORT = 3120;

test("the API refuses a foreign Host and a page on another site, and still serves this origin", async ({ page, request }) => {
  const rebind = await request.get("/api/participants", { headers: { host: `rebind.example:${PORT}` } });
  expect(rebind.status()).toBe(403);
  expect(await rebind.json()).toMatchObject({ code: "request_host_not_allowed", params: { host: `rebind.example:${PORT}` } });
  const foreign = await request.post("/api/participants", { data: { name: "Mallory" }, headers: { origin: "https://evil.example" } });
  expect(foreign.status()).toBe(403);
  expect(await foreign.json()).toMatchObject({ code: "request_cross_site" });

  // A real browser on another site (127.0.0.1 and localhost are different sites) sends a "simple" text/plain POST,
  // the kind no CORS preflight stops: the write must not land.
  await page.goto(`http://127.0.0.1:${PORT}/api/health`);
  await page.evaluate(async (url) => {
    await fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ name: "Mallory" }) });
  }, `http://localhost:${PORT}/api/participants`);
  const people = (await (await request.get("/api/participants")).json()) as { participants: { name: string }[] };
  expect(people.participants.map((p) => p.name)).not.toContain("Mallory");
});
