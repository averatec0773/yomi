import { existsSync, statSync } from "node:fs";
import { expect, test } from "./fixtures";
import { E2E_KEY_FILE, E2E_NOW } from "../playwright.config";

// Fictional values the YOMI_E2E fakes accept (apps/web/lib/e2e-fakes.ts); nothing here reaches IBKR or Plaid.
const TOKEN = "test-token-3141";
const QUERY = "123456";

/** YYYY-MM-DD `days` from the pinned today (E2E_NOW) in the zone the e2e browser reports (the app stores it on the first visit). */
function inDays(days: number): string {
  const d = new Date(Date.parse(E2E_NOW) + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// Later specs expect IBKR and Plaid unset on this server: remove anything a failed run left behind.
test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: "http://localhost:3120" });
  await api.delete("/api/settings/secrets/ibkr");
  for (const field of ["clientId", "sandbox", "production"]) await api.delete(`/api/settings/secrets/plaid/${field}`);
  await api.dispose();
});

test("IBKR: set up with a tested token, sync, replace and remove; the token never reaches the page", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings?tab=connections");
  const ibkr = page.getByTestId("ibkr-row");
  await expect(ibkr.getByTestId("source-meta")).toContainText("Not set up");
  await ibkr.getByRole("button", { name: "Set up" }).click();

  const dialog = page.getByRole("dialog", { name: "Set up Interactive Brokers" });
  const guide = dialog.getByTestId("ibkr-guide");
  await expect(guide.getByRole("listitem")).toHaveCount(5);
  await expect(guide.getByRole("link", { name: "Client Portal" })).toHaveAttribute("href", "https://www.interactivebrokers.com/portal/");
  await expect(guide).toContainText("Any Period works because yomi asks for its own dates");
  await expect(guide).toContainText("Account Information with only Account ID, Account Alias and Currency");
  await expect(guide.getByRole("link", { name: "IBKR API reference" })).toHaveAttribute("href", "https://www.interactivebrokers.com/docs/web-api/api-reference/send-request");
  await expect(dialog.getByTestId("secret-key-note")).toContainText("Saving creates a key file at");
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  // The identifier comes first, then the secret.
  expect(await dialog.locator("input[id^='secret-input-']").evaluateAll((els) => els.map((e) => e.id))).toEqual(["secret-input-ibkr-query", "secret-input-ibkr-token"]);
  await expect(dialog.getByLabel("Flex query ID")).toHaveAttribute("type", "text");

  // The eye shows only what is being typed: no button while the token is empty and nothing is saved.
  const tokenInput = dialog.getByLabel("Flex token");
  await expect(tokenInput).toHaveAttribute("type", "password");
  await expect(tokenInput).toHaveAttribute("autocomplete", "off");
  await expect(tokenInput).toHaveAttribute("spellcheck", "false");
  await expect(dialog.getByTestId("secret-toggle-ibkr-token")).toHaveCount(0);
  await tokenInput.fill("typed-token-0000");
  const show = dialog.getByRole("button", { name: "Show value" });
  await expect(show).toHaveAttribute("aria-pressed", "false");
  await show.click();
  await expect(tokenInput).toHaveAttribute("type", "text");
  const hide = dialog.getByRole("button", { name: "Hide value" });
  await expect(hide).toHaveAttribute("aria-pressed", "true");
  await hide.click();
  await expect(tokenInput).toHaveAttribute("type", "password");
  await show.click();
  // Emptying the field hides it again.
  await tokenInput.fill("");
  await expect(tokenInput).toHaveAttribute("type", "password");

  // A token IBKR refuses: the calm sentence, Save stays off until the user opts out of the test.
  await dialog.getByLabel("Flex token").fill("wrong-token-0000");
  await dialog.getByLabel("Flex query ID").fill(QUERY);
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog.getByTestId("ibkr-test-result")).toContainText("IBKR does not accept the Flex token.", { timeout: 20_000 });
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Save without a successful test" }).click();
  await expect(dialog).toContainText("yomi could not confirm these values work.");
  await expect(save).toBeEnabled();

  // The right token: SendRequest, GetStatement, then the statement date and positions.
  await dialog.getByLabel("Flex token").fill(TOKEN);
  await expect(dialog.getByRole("checkbox", { name: "Save without a successful test" })).toBeVisible();
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog.getByTestId("ibkr-test-result")).toContainText("Connected. Statement for Sep 28, 2026, 3 positions.", { timeout: 20_000 });
  await dialog.getByTestId("ibkr-expires-on").fill(inDays(5));
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText("Interactive Brokers is set up")).toBeVisible();
  await expect(dialog).toBeHidden();

  // No restart: the row is set up at once, with the expiry reminder, and Sync now pulls through the saved token.
  const meta = ibkr.getByTestId("source-meta");
  await expect(meta).toContainText("Flex report");
  await expect(ibkr.getByTestId("ibkr-expiry")).toHaveText("Token expires in 5 days");
  await ibkr.getByTestId("source-actions").getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText(/^Synced: Interactive Brokers, 5 positions/)).toBeVisible({ timeout: 20_000 });
  await expect(meta).toContainText(/Synced (just now|\d+ (second|minute)s? ago)/);
  expect(await page.content()).not.toContain(TOKEN);

  // Pull history: a number of days within IBKR's 365-day limit, ending on the last trading day (Tuesday 09-29 at
  // the pinned clock); a second pull within 10 minutes is refused with the reason, in the dialog.
  await ibkr.getByRole("button", { name: "More actions for Interactive Brokers" }).click();
  await page.getByRole("menuitem", { name: "Pull history…" }).click();
  const history = page.getByRole("dialog", { name: "Pull IBKR history" });
  const days = history.getByLabel("Days of history");
  await expect(days).toHaveValue("365");
  await expect(history).toContainText("older activity can't be pulled through the Flex Web Service");
  await days.fill("400");
  await expect(history.getByTestId("ibkr-history-error")).toHaveText("Enter a whole number of days from 1 to 365.");
  await expect(history.getByTestId("ibkr-history-pull")).toBeDisabled();
  await days.fill("30");
  await expect(history.getByTestId("ibkr-history-error")).toHaveText("");
  await history.getByTestId("ibkr-history-pull").click();
  await expect(page.getByText("IBKR activity from Aug 31, 2026 to Sep 29, 2026: 0 new transactions")).toBeVisible({ timeout: 20_000 });
  await expect(history).toBeHidden();
  await ibkr.getByRole("button", { name: "More actions for Interactive Brokers" }).click();
  await page.getByRole("menuitem", { name: "Pull history…" }).click();
  await history.getByTestId("ibkr-history-pull").click();
  await expect(history.getByTestId("ibkr-history-error")).toContainText("IBKR was pulled less than 10 minutes ago");
  await expect(history.getByTestId("ibkr-history-error")).toContainText("Try again in 10 min.");
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();

  // The master key was created on first need, outside the database, readable by the owner only.
  expect(existsSync(E2E_KEY_FILE)).toBe(true);
  expect(statSync(E2E_KEY_FILE).mode & 0o777).toBe(0o600);
  await page.goto("/settings?tab=security");
  await expect(page.getByTestId("settings-security")).toContainText("Back up your key file");

  // Replace: the saved token shows only its last 4; a new one is tested and saved.
  await page.goto("/settings?tab=connections");
  await ibkr.getByRole("button", { name: "More actions for Interactive Brokers" }).click();
  await page.getByRole("menuitem", { name: "Replace token" }).click();
  const replace = page.getByRole("dialog", { name: "Replace the IBKR token" });
  await expect(replace.getByTestId("secret-ibkr-token")).toContainText("Saved, ends in 3141. Type a new value to replace it.");
  await expect(replace.getByLabel("Flex token")).toHaveValue("");
  // The saved query ID is shown in clear and editable; the saved token cannot be revealed.
  await expect(replace.getByLabel("Flex query ID")).toHaveValue(QUERY);
  await expect(replace.getByLabel("Flex query ID")).toBeEditable();
  const savedToggle = replace.getByTestId("secret-toggle-ibkr-token");
  await expect(savedToggle).toHaveAttribute("aria-disabled", "true");
  await expect(savedToggle).toHaveAttribute("title", "Saved values can't be shown; type a new one to replace it");
  await savedToggle.click({ force: true });
  await expect(replace.getByLabel("Flex token")).toHaveAttribute("type", "password");
  await replace.getByLabel("Flex token").fill(TOKEN);
  await replace.getByRole("button", { name: "Test connection" }).click();
  await expect(replace.getByTestId("ibkr-test-result")).toContainText("Connected.", { timeout: 20_000 });
  await replace.getByRole("button", { name: "Save" }).click();
  await expect(replace).toBeHidden();

  // Remove asks first (sm dialog), then the row is back to Not set up.
  await ibkr.getByRole("button", { name: "More actions for Interactive Brokers" }).click();
  await page.getByRole("menuitem", { name: "Replace token" }).click();
  await replace.getByRole("button", { name: "Remove…" }).click();
  const confirm = page.getByTestId("ibkr-remove-dialog");
  await expect(confirm).toContainText("Remove the IBKR token?");
  await confirm.getByRole("button", { name: "Keep" }).click();
  await expect(confirm).toBeHidden();
  await replace.getByRole("button", { name: "Remove…" }).click();
  await confirm.getByRole("button", { name: "Remove token" }).click();
  await expect(page.getByText("IBKR token removed")).toBeVisible();
  await expect(meta).toContainText("Not set up");
});

test("Plaid developer keys: test per environment reports success or Plaid's error code; Save waits for a passing test", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings?tab=connections#developer-keys");
  const keys = page.getByTestId("developer-keys");
  await expect(keys.getByRole("button", { name: /Developer keys/ })).toHaveAttribute("aria-expanded", "true");
  await expect(keys.getByTestId("plaid-guide")).toContainText(/Last checked \w{3} \d{1,2}, \d{4}/);
  const save = keys.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  // Client ID, then the two secrets, then the default environment.
  expect(await keys.locator("input[id^='secret-input-'], [data-testid='plaid-default-env']").evaluateAll((els) => els.map((e) => e.id || e.getAttribute("data-testid")))).toEqual([
    "secret-input-plaid-client-id",
    "secret-input-plaid-sandbox",
    "secret-input-plaid-production",
    "plaid-default-env",
  ]);
  await expect(keys.getByLabel("Client ID")).toHaveAttribute("type", "text");
  await expect(keys.getByLabel("Sandbox secret")).toHaveAttribute("type", "password");

  await keys.getByLabel("Client ID").fill("test-client-3141");
  await keys.getByLabel("Sandbox secret").fill("test-secret-3141");
  await keys.getByLabel("Production secret").fill("wrong-secret-0000");
  await keys.getByTestId("secret-toggle-plaid-sandbox").click();
  await expect(keys.getByLabel("Sandbox secret")).toHaveAttribute("type", "text");
  await expect(keys.getByLabel("Production secret")).toHaveAttribute("type", "password");
  const [sandboxTest, productionTest] = await keys.getByRole("button", { name: "Test keys" }).all();
  await sandboxTest!.click();
  await expect(keys.getByTestId("plaid-test-sandbox")).toHaveText("Plaid accepted these keys.");
  await productionTest!.click();
  await expect(keys.getByTestId("plaid-test-production")).toHaveText("Plaid said: INVALID_API_KEYS");
  // Production did not pass: saving needs the explicit opt-out.
  await expect(save).toBeDisabled();
  await keys.getByRole("checkbox", { name: "Save without a successful test" }).click();
  await expect(save).toBeEnabled();
  // Nothing is saved here, so later specs still see Plaid unset.
});

test("secrets are refused over plain HTTP to a non-local host", async ({ request }) => {
  const res = await request.put("/api/settings/secrets/ibkr", { data: { token: TOKEN }, headers: { host: "192.168.1.20:3120" } });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ code: "secrets_insecure_origin" });
});
