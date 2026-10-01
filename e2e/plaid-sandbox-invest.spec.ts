import { expect, type Frame, type Page, test } from "@playwright/test";
import { connections, dbPath, mask, plaidFrame, query, session } from "./plaid-helpers";

/**
 * "Connect brokerage" through the real Plaid Link in Sandbox, driven end to end from /assets.
 * Opt-in only, like plaid-sandbox.spec.ts: PLAID_SANDBOX_E2E=1 with a server started with
 * PLAID_ENV=sandbox on a throwaway postgres:// DATABASE_URL, passed here as PLAID_E2E_DB.
 *
 * Uses Plaid's published Sandbox login (user_good / pass_good) at a non-OAuth test institution that
 * offers investment accounts (default "First Platypus Bank", override with PLAID_E2E_INVEST_INSTITUTION).
 * Each test uses one Sandbox Item.
 *
 * A: normal completion. B: Link exited on its last pane after the login; server-side recovery must
 * still save the brokerage connection and its holdings.
 */

test.skip(!dbPath, "PLAID_E2E_DB must point at the server's throwaway DATABASE_URL");

const INSTITUTION = process.env.PLAID_E2E_INVEST_INSTITUTION ?? "First Platypus Bank";

const investAccounts = (connectionId: number) =>
  query<{ id: number; name: string; provider: string }>("select id, name, provider from investment_accounts where bank_connection_id = $1", connectionId);
const snapshots = (connectionId: number) =>
  query<{ n: number; days: number }>(
    "select count(*)::int as n, count(distinct h.as_of)::int as days from holding_snapshots h join investment_accounts a on a.id = h.investment_account_id where a.bank_connection_id = $1",
    connectionId,
  ).then((r) => r[0]!);

/** Plaid's last pane before onSuccess: the "Success" / connected screen. */
// The last pane is Plaid's consent pane with "Share data" (same as the bank flow in plaid-sandbox.spec.ts).
const finalPane = (f: Frame) => f.getByRole("button", { name: "Share data" });
const nextButton = (f: Frame) => f.getByRole("button", { name: /^(Continue|Submit|Allow|Confirm)$/ }).first();

/**
 * Opens Link from "Connect brokerage" on /assets (Sandbox only), picks the institution, logs in with
 * user_good / pass_good and walks the panes until Plaid's last one. Returns the link session id.
 */
async function loginUpToFinalPane(page: Page): Promise<{ sessionId: number; frame: Frame }> {
  await page.goto("/assets");
  const box = page.getByTestId("connect-brokerage");
  await expect(box).toContainText("uses one Plaid Item");
  const tokenResp = page.waitForResponse((r) => r.url().endsWith("/api/bank/link-token"));
  await box.getByRole("button", { name: "Connect brokerage" }).click();
  const resp = await tokenResp;
  expect(JSON.parse(resp.request().postData() ?? "{}")).toEqual({ environment: "sandbox", purpose: "brokerage" });
  const lt = (await resp.json()) as { linkToken: string; sessionId: number };
  expect(lt.linkToken.startsWith("link-sandbox-"), "only Sandbox link tokens").toBe(true);
  expect((await session(lt.sessionId))?.kind).toBe("brokerage");

  const f = await plaidFrame(page);
  const noPhone = f.getByRole("button", { name: "Continue without phone number" });
  const search = f.getByPlaceholder("Search");
  await expect(noPhone.or(search)).toBeVisible({ timeout: 30_000 });
  if (await noPhone.isVisible()) await noPhone.click();
  await search.fill(INSTITUTION);
  await f.getByText(INSTITUTION, { exact: true }).first().click();
  // Some institutions ask which variant or show an intro pane before the credentials.
  const user = f.getByLabel(/user ?(name|id)/i).or(f.getByPlaceholder(/user ?(name|id)/i)).first();
  for (let i = 0; i < 3 && !(await user.isVisible().catch(() => false)); i++) {
    const variant = f.getByRole("button", { name: INSTITUTION, exact: true });
    if (await variant.isVisible().catch(() => false)) await variant.click();
    else if (await nextButton(f).isVisible().catch(() => false)) await nextButton(f).click();
    await page.waitForTimeout(1_000);
  }
  await user.fill("user_good");
  await f.getByLabel(/password/i).or(f.getByPlaceholder(/password/i)).first().fill("pass_good");
  await f.getByRole("button", { name: /^(Submit|Continue|Log in|Sign in)$/ }).first().click();

  // Account selection and consent panes (investment accounts are preselected), up to the last pane.
  for (let i = 0; i < 6; i++) {
    if (await finalPane(f).isVisible({ timeout: 5_000 }).catch(() => false)) break;
    // Account selection ("Your accounts") keeps Continue disabled until an account is ticked.
    const boxes = f.getByRole("checkbox");
    if ((await boxes.count()) > 0) {
      let anyChecked = false;
      for (const b of await boxes.all()) if (await b.isChecked().catch(() => false)) anyChecked = true;
      if (!anyChecked) await boxes.first().click({ force: true }).catch(() => undefined);
    }
    const next = nextButton(f);
    if (await next.isVisible().catch(() => false)) {
      // Long account lists put Continue below the fold; scroll it into view before clicking.
      await next.scrollIntoViewIfNeeded().catch(() => undefined);
      if (await next.isEnabled().catch(() => false)) await next.click().catch(() => next.click({ force: true }));
      await page.waitForTimeout(1_500);
    }
  }
  await expect(finalPane(f)).toBeVisible({ timeout: 60_000 });
  return { sessionId: lt.sessionId, frame: f };
}

/** The brokerage connection has investment accounts and at least one day of holdings; one Sync now if the first pull was not in yet. */
async function expectHoldings(page: Page, connectionId: number): Promise<{ accounts: number; rows: number }> {
  const conn = (await connections()).find((c) => c.id === connectionId);
  expect(conn?.kind).toBe("brokerage");
  const ok = await expect
    .poll(async () => (await snapshots(connectionId)).n, { timeout: 20_000 })
    .toBeGreaterThan(0)
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    await page.goto("/assets");
    const sync = page.waitForResponse((r) => r.url().endsWith("/api/invest/sync"), { timeout: 60_000 });
    await page.getByTestId("assets-sources").getByRole("button", { name: "Sync now" }).first().click();
    await sync;
    await expect.poll(async () => (await snapshots(connectionId)).n, { timeout: 30_000 }).toBeGreaterThan(0);
  }
  const accounts = await investAccounts(connectionId);
  expect(accounts.length).toBeGreaterThan(0);
  expect(accounts.every((a) => a.provider === "plaid")).toBe(true);
  await page.goto("/assets");
  await expect(page.getByTestId("assets-account").first()).toBeVisible();
  await expect(page.getByTestId("assets-position").first()).toBeVisible();
  return { accounts: accounts.length, rows: (await snapshots(connectionId)).n };
}

test("A: connect a brokerage through the last pane saves a brokerage connection with holdings", async ({ page }) => {
  const before = (await connections()).length;
  const { sessionId, frame } = await loginUpToFinalPane(page);
  const exchange = page.waitForResponse((r) => r.url().endsWith("/api/bank/exchange"), { timeout: 60_000 });
  await finalPane(frame).click();
  const res = await exchange;
  expect(res.status()).toBe(200);
  const out = (await res.json()) as { connection: { id: number; institutionName: string; kind: string }; syncError: string | null };
  expect(out.connection.kind).toBe("brokerage");
  await expect.poll(async () => (await session(sessionId))?.status, { timeout: 30_000 }).toMatch(/^(completed|recovered)$/);
  expect((await connections()).length).toBe(before + 1);
  const r = await expectHoldings(page, out.connection.id);
  console.log(
    `[A] exchange ${res.status()} connection #${out.connection.id} ${out.connection.institutionName} item ${mask((await connections()).at(-1)!.enrollment_id)}; syncError ${out.syncError ?? "none"}; ${r.accounts} investment accounts, ${r.rows} holding rows`,
  );
});

test("B: exit on the last pane after the login is recovered with holdings", async ({ page }) => {
  const before = (await connections()).length;
  const { sessionId, frame } = await loginUpToFinalPane(page);
  const recover = page.waitForResponse((r) => r.url().endsWith("/api/bank/link-sessions/recover"), { timeout: 60_000 });
  await frame.getByRole("button", { name: /^(Exit|Close)$/ }).first().click();
  const confirm = frame.getByRole("button", { name: /^(Exit|Yes, exit|Exit anyway)$/ });
  if (await confirm.first().isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.first().click();
  const first = await recover;
  await expect(page.getByText(new RegExp(`Recovered the unfinished bank connection: ${INSTITUTION}`))).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await session(sessionId))?.status, { timeout: 30_000 }).toBe("recovered");
  expect((await connections()).length).toBe(before + 1);
  const s = (await session(sessionId))!;
  const r = await expectHoldings(page, s.connection_id!);
  console.log(`[B] recover ${first.status()} connection #${s.connection_id} item ${mask((await connections()).at(-1)!.enrollment_id)}; ${r.accounts} investment accounts, ${r.rows} holding rows; session ${JSON.stringify(s)}`);
});
