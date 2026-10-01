import { expect, type Frame, type Page, test } from "@playwright/test";
import { connections, dbPath, mask, plaidFrame, query, session } from "./plaid-helpers";

/**
 * Real Plaid Link in Sandbox, driven end to end. Opt-in only (PLAID_SANDBOX_E2E=1, see
 * playwright.config.ts): needs Plaid Sandbox keys, network, and a server started with
 * PLAID_ENV=sandbox on a throwaway postgres:// DATABASE_URL, passed here as PLAID_E2E_DB.
 *
 * Uses Plaid's published Sandbox test login (user_good / pass_good, code 1234) at the OAuth test
 * institution "Platypus OAuth Bank", which opens the bank in a popup like Bank of America does.
 *
 * A: normal completion through "Share data". B: bank login done, Link exited on the "Share data"
 * pane (the production incident). C: page reloaded on that pane. B and C must end with the Item
 * saved and synced through server-side recovery.
 */

test.skip(!dbPath, "PLAID_E2E_DB must point at the server's throwaway DATABASE_URL");

const plaidRows = (connectionId: number) =>
  query<{ n: number }>(
    "select count(*)::int as n from transactions t join bank_accounts b on b.provider_account_id = t.raw->>'account_id' where t.source = 'plaid' and b.connection_id = $1",
    connectionId,
  ).then((r) => r[0]!.n);

/**
 * Opens Link from "Connect bank" (Sandbox only: refuses any other environment), logs in to Platypus
 * OAuth Bank through its popup and stops on Plaid's last pane ("Share data"). Returns the link
 * session id yomi recorded.
 */
async function loginUpToSharePane(page: Page): Promise<{ sessionId: number; frame: Frame }> {
  await page.goto("/settings?tab=connections");
  const section = page.getByTestId("settings-connections");
  await expect(section).toBeVisible();
  const tokenResp = page.waitForResponse((r) => r.url().endsWith("/api/bank/link-token"));
  await section.getByRole("button", { name: "Connect bank", exact: true }).click();
  const resp = await tokenResp;
  expect(JSON.parse(resp.request().postData() ?? "{}")).toEqual({ environment: "sandbox" });
  const lt = (await resp.json()) as { linkToken: string; sessionId: number };
  expect(lt.linkToken.startsWith("link-sandbox-"), "only Sandbox link tokens").toBe(true);

  const f = await plaidFrame(page);
  const noPhone = f.getByRole("button", { name: "Continue without phone number" });
  const search = f.getByPlaceholder("Search");
  await expect(noPhone.or(search)).toBeVisible({ timeout: 30_000 });
  if (await noPhone.isVisible()) await noPhone.click();
  await search.fill("Platypus OAuth");
  await f.getByText("Platypus OAuth Bank", { exact: true }).first().click();
  const variant = f.getByRole("button", { name: "Platypus OAuth Bank", exact: true });
  const toLogin = f.getByRole("button", { name: "Continue to log in" });
  await expect(variant.or(toLogin)).toBeVisible();
  if (await variant.isVisible()) await variant.click();

  const popupP = page.context().waitForEvent("page");
  await toLogin.click();
  const bank = await popupP;
  await bank.locator("#username").fill("user_good");
  await bank.locator("#password").fill("pass_good");
  await bank.locator("#submit-credentials").click();
  await bank.locator("#submit-device").click();
  await bank.locator("#verify-code #code").fill("1234");
  await bank.locator("#submit-code").click();
  await bank.locator('label[for="account_0"]').click(); // Plaid Checking
  await bank.locator('label[for="account_3"]').click(); // Plaid Credit Card
  await bank.locator("#submit-accounts").click();
  await bank.locator("#terms-label").click();
  await bank.locator("#submit-confirmation").click();

  await expect(f.getByRole("button", { name: "Share data" })).toBeVisible({ timeout: 60_000 });
  return { sessionId: lt.sessionId, frame: f };
}

test("A: normal completion through Share data saves the connection and syncs", async ({ page }) => {
  const before = (await connections()).length;
  const { sessionId, frame } = await loginUpToSharePane(page);
  const exchange = page.waitForResponse((r) => r.url().endsWith("/api/bank/exchange"), { timeout: 60_000 });
  await frame.getByRole("button", { name: "Share data" }).click();
  const res = await exchange;
  expect(res.status()).toBe(200);
  const out = (await res.json()) as { connection: { id: number; institutionName: string }; sync: { inserted: number } | null };
  await expect.poll(async () => (await session(sessionId))?.status, { timeout: 30_000 }).toMatch(/^(completed|recovered)$/);
  const conns = await connections();
  expect(conns.length).toBe(before + 1);
  const rows = await plaidRows(out.connection.id);
  expect(rows).toBeGreaterThan(0);
  console.log(
    `[A] exchange ${res.status()} connection #${out.connection.id} ${out.connection.institutionName} item ${mask(conns.at(-1)!.enrollment_id)}; first sync inserted ${out.sync?.inserted ?? "n/a"}; rows in DB ${rows}; session ${JSON.stringify((await session(sessionId)))}`,
  );
});

test("B: exit on the Share data pane after the bank login is recovered and synced", async ({ page }) => {
  const before = (await connections()).length;
  const { sessionId, frame } = await loginUpToSharePane(page);
  const recover = page.waitForResponse((r) => r.url().endsWith("/api/bank/link-sessions/recover"), { timeout: 60_000 });
  // Leave without sharing: the top Exit button, then confirm if Plaid asks.
  await frame.getByRole("button", { name: "Exit" }).first().click();
  const confirm = frame.getByRole("button", { name: /^(Exit|Yes, exit|Exit anyway)$/ });
  if (await confirm.first().isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.first().click();
  const first = await recover;
  const body = (await first.json()) as { sessions: { status: string; exitStatus: string | null; linkSessionId: string | null }[]; recovered: { institutionName: string }[] };
  await expect(page.getByText(/Recovered the unfinished bank connection: Platypus OAuth Bank/)).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await session(sessionId))?.status, { timeout: 30_000 }).toBe("recovered");
  const conns = await connections();
  expect(conns.length).toBe(before + 1);
  const s = (await session(sessionId))!;
  await expect.poll(() => plaidRows(s.connection_id!), { timeout: 60_000 }).toBeGreaterThan(0);
  const rows = await plaidRows(s.connection_id!);
  expect(await page.getByTestId("settings-connections").innerText()).toContain("Platypus OAuth Bank");
  console.log(
    `[B] recover ${first.status()} ${JSON.stringify({ ...body, sessions: body.sessions.map((x) => ({ ...x, recovered: undefined })) }).slice(0, 400)}; connection #${s.connection_id} item ${mask(conns.at(-1)!.enrollment_id)}; rows ${rows}; session ${JSON.stringify(s)}`,
  );
});

test("C: reload on the Share data pane is recovered on the next page load", async ({ page }) => {
  const before = (await connections()).length;
  const { sessionId } = await loginUpToSharePane(page);
  page.on("dialog", (d) => void d.accept()); // the beforeunload guard
  const recover = page.waitForResponse((r) => r.url().endsWith("/api/bank/link-sessions/recover") && r.request().postData() === "{}", { timeout: 60_000 });
  await page.reload();
  const res = await recover;
  const body = (await res.json()) as { recovered: { institutionName: string; sync: { inserted: number } | null }[] };
  await expect.poll(async () => (await session(sessionId))?.status, { timeout: 30_000 }).toMatch(/^(recovered|open)$/);
  const conns = await connections();
  expect(conns.length).toBe(before + 1);
  const s = (await session(sessionId))!;
  await expect.poll(() => plaidRows(s.connection_id!), { timeout: 60_000 }).toBeGreaterThan(0);
  const rows = await plaidRows(s.connection_id!);
  if (body.recovered.length) await expect(page.getByText(/Recovered the unfinished bank connection: Platypus OAuth Bank/)).toBeVisible();
  console.log(
    `[C] mount recover ${res.status()} recovered=${JSON.stringify(body.recovered.map((r) => [r.institutionName, r.sync?.inserted]))}; connection #${s.connection_id} item ${mask(conns.at(-1)!.enrollment_id)}; rows ${rows}; session ${JSON.stringify(s)}`,
  );
});
