import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { ACCESS_E2E_IBKR_TOKEN, ACCESS_E2E_PLAID_CLIENT_ID, ACCESS_E2E_PORT, ACCESS_E2E_TOKEN } from "../playwright.config";

/** Vertical overlap of two boxes: they sit on one line. */
async function sameLine(a: Locator, b: Locator): Promise<boolean> {
  const x = (await a.boundingBox())!;
  const y = (await b.boundingBox())!;
  return x.y < y.y + y.height && y.y < x.y + x.height;
}

const bankRow = (page: Page) => page.getByTestId("connections-banks").getByTestId("connection-row").filter({ hasText: "Bank of America" });

test("connections at 1440: banks and brokerages as rows with pill, status, synced time and actions on one line; IBKR not set up", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings?tab=connections");
  const panel = page.getByTestId("settings-connections");
  // The demo server has Plaid blanked: one calm line whose action opens the Developer keys group (collapsed by default).
  await expect(panel.getByTestId("plaid-setup")).toContainText("Plaid is not set up");
  await expect(panel.getByTestId("connect-actions")).toHaveCount(0);
  const devKeys = panel.getByTestId("developer-keys");
  await expect(devKeys.getByRole("button", { name: /Developer keys/ })).toHaveAttribute("aria-expanded", "false");
  await expect(devKeys).toContainText("Only needed when you run yomi yourself");
  await panel.getByTestId("plaid-setup").getByRole("link", { name: "Add developer keys" }).click();
  await expect(devKeys.getByRole("button", { name: /Developer keys/ })).toHaveAttribute("aria-expanded", "true");
  await expect(devKeys.getByTestId("plaid-guide")).toContainText("How to get Plaid keys");
  await expect(devKeys.getByTestId("plaid-guide").getByRole("link", { name: "Keys" })).toHaveAttribute("href", "https://dashboard.plaid.com/developers/keys");
  await devKeys.getByRole("button", { name: /Developer keys/ }).click();
  await expect(devKeys.getByTestId("plaid-guide")).toHaveCount(0);

  // Bank of America: Production pill, Active, "Synced …" with the absolute time on hover, then the actions.
  const boa = bankRow(page);
  const meta = boa.getByTestId("source-meta");
  await expect(meta).toContainText(/Production\s*Active\s*Synced \S/);
  await expect(meta.getByText(/^Synced /)).toHaveAttribute("title", /^Last synced \w{3} \d{1,2}, \d{2}:\d{2} · Transactions sync every 6 hours$/);
  await expect(boa).toContainText("Adv Plus Banking •••• 5501 · Deposit account");
  const actions = boa.getByTestId("source-actions");
  await expect(actions.getByRole("button")).toHaveText(["Pause", "Sync now"]);
  expect(await sameLine(meta.getByText("Production"), actions.getByRole("button", { name: "Sync now" }))).toBe(true);
  expect((await boa.boundingBox())!.height).toBeGreaterThanOrEqual(60);
  // No danger zone or underlined action links in the tab.
  await expect(panel.getByTestId("bank-danger-zone")).toHaveCount(0);
  await expect(panel.locator("button.underline")).toHaveCount(0);

  // Brokerages: Interactive Brokers first (not set up in the demo server), then Robinhood through Plaid, linking to Assets.
  const brokerages = page.getByTestId("connections-brokerages");
  const ibkr = brokerages.getByTestId("ibkr-row");
  await expect(ibkr).toContainText("Interactive Brokers");
  await expect(ibkr.getByTestId("source-meta")).toContainText(/Not set up\s*Last statement Sep 28/);
  await ibkr.getByRole("button", { name: "Set up" }).click();
  const ibkrSheet = page.getByRole("dialog", { name: "Set up Interactive Brokers" });
  await expect(ibkrSheet.getByTestId("ibkr-guide")).toContainText("How to get the token and query ID");
  await expect(ibkrSheet.getByTestId("ibkr-guide")).toContainText(/Last checked \w{3} \d{1,2}, \d{4}/);
  await expect(ibkrSheet.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.keyboard.press("Escape");
  const rh = brokerages.getByTestId("connection-row").filter({ hasText: "Robinhood" });
  await expect(rh.getByTestId("source-meta")).toContainText(/Production\s*Active\s*Synced/);
  await expect(rh.getByRole("link", { name: "Robinhood" })).toHaveAttribute("href", "/assets?view=investments");

  // The overflow menu holds Disconnect… (the typed confirmation) and, for a brokerage, Open in Assets.
  await boa.getByRole("button", { name: "More actions for Bank of America" }).click();
  await expect(page.getByRole("menu").getByRole("menuitem").locator("visible=true")).toHaveText(["Disconnect…"]);
  await page.getByRole("menuitem", { name: "Disconnect…" }).click();
  const dialog = page.getByTestId("disconnect-dialog");
  await expect(dialog).toContainText("Disconnect and delete Bank of America?");
  await expect(dialog.getByRole("button", { name: "I understand, disconnect and delete" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Pause and Resume stay on this computer (nothing is sent to Plaid).
  await actions.getByRole("button", { name: "Pause" }).click();
  await expect(meta).toContainText("Paused");
  await expect(actions.getByRole("button")).toHaveText(["Resume"]);
  await actions.getByRole("button", { name: "Resume" }).click();
  await expect(meta).toContainText("Active");
  await expect(actions.getByRole("button")).toHaveText(["Pause", "Sync now"]);

  await expect(panel.getByTestId("connections-privacy")).toContainText("Bank passwords are entered only in Plaid's window.");
  await expect(panel).not.toContainText("6 hours");
  await expect(panel).not.toContainText("yomi.db");

  // Tools > Bank and brokerage connections and the old /import#bank land here.
  await page.goto("/import#bank");
  await page.getByRole("link", { name: "Settings / Connections" }).click();
  await expect(page).toHaveURL(/\/settings\?tab=connections$/);
  await expect(page.getByTestId("settings-connections")).toBeVisible();
});

test("connections at 390: row actions collapse into the overflow menu, no sideways scroll, 中文", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings?tab=connections");
  const boa = bankRow(page);
  await expect(boa.getByTestId("source-meta")).toContainText("Production");
  await expect(boa.getByTestId("source-actions")).toBeHidden();
  const more = boa.getByRole("button", { name: "More actions for Bank of America" });
  expect((await more.boundingBox())!.width).toBeGreaterThan(0);
  await more.click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Sync now", "Pause", "Disconnect…"]);
  await page.keyboard.press("Escape");
  const ibkr = page.getByTestId("ibkr-row");
  await ibkr.getByRole("button", { name: "More actions for Interactive Brokers" }).click();
  await page.getByRole("menuitem", { name: "Set up" }).click();
  await expect(page.getByRole("dialog", { name: "Set up Interactive Brokers" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.context().addCookies([{ name: "locale", value: "zh-CN", url: page.url() }]);
  await page.reload();
  await expect(bankRow(page).getByTestId("source-meta")).toContainText(/正式\s*正常\s*\S+同步/);
  await expect(page.getByTestId("ibkr-row")).toContainText("盈透证券 IBKR");
  await expect(page.getByTestId("ibkr-row")).toContainText("未设置");
  await expect(page.getByTestId("connections-privacy")).toContainText("银行密码只在 Plaid 的窗口里输入。");
  await page.context().clearCookies({ name: "locale" });
});

test.describe("with IBKR set up (the access server)", () => {
  test.use({ baseURL: `http://localhost:${ACCESS_E2E_PORT}` });

  test("IBKR row: Flex report, synced time, positions on the statement date, token sheet without the token", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/settings?tab=connections&token=${ACCESS_E2E_TOKEN}`);
    const ibkr = page.getByTestId("ibkr-row");
    const meta = ibkr.getByTestId("source-meta");
    await expect(meta).toContainText(/Flex report\s*(Active|Waiting for today's statement)\s*Synced \S/);
    await expect(ibkr).toContainText("3 positions on Sep 28");
    await expect(ibkr).not.toContainText("Not set up");
    await expect(ibkr.getByRole("link", { name: "Interactive Brokers" })).toHaveAttribute("href", "/assets?view=investments");
    const sync = ibkr.getByTestId("source-actions").getByRole("button", { name: "Sync now" });
    expect(await sameLine(meta.getByText("Flex report"), sync)).toBe(true);
    await ibkr.getByRole("button", { name: "More actions for Interactive Brokers" }).click();
    await page.getByRole("menuitem", { name: "Replace token" }).click();
    // Both values come from env: read-only "Set by environment" with the one-line explanation, no input.
    const sheet = page.getByRole("dialog", { name: "Replace the IBKR token" });
    await expect(sheet.getByTestId("secret-ibkr-token")).toContainText("Set by environment");
    await expect(sheet.getByTestId("secret-ibkr-token")).toContainText("IBKR_FLEX_TOKEN in the environment wins over Settings.");
    await expect(sheet.getByTestId("secret-ibkr-token").getByRole("textbox")).toHaveCount(0);
    await expect(sheet.getByTestId("secret-ibkr-query")).toContainText("Set by environment");
    expect(await page.content()).not.toContain(ACCESS_E2E_IBKR_TOKEN);
    await page.keyboard.press("Escape");

    // Developer keys: the client id set by env is read-only, the secrets stay editable.
    const devKeys = page.getByTestId("developer-keys");
    await devKeys.getByRole("button", { name: /Developer keys/ }).click();
    await expect(devKeys.getByTestId("secret-plaid-client-id")).toContainText("Set by environment, ends in 3141");
    await expect(devKeys.getByTestId("secret-plaid-client-id").getByRole("textbox")).toHaveCount(0);
    await expect(devKeys.getByTestId("secret-plaid-client-id")).toContainText("PLAID_CLIENT_ID in the environment wins over Settings.");
    await expect(devKeys.getByRole("textbox", { name: "Sandbox secret" })).toBeEditable();
    expect(await page.content()).not.toContain(ACCESS_E2E_PLAID_CLIENT_ID);
  });
});
