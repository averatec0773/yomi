import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Sidebar destinations with a leader key: Transactions, Stats, Assets, Tools, Split and settle, Import, Rules, Settings. */
const NAV_HINTS = 8;

// Every test leaves the stored shortcuts at the defaults, so the other specs keep "\" as the leader.
test.afterEach(async ({ request }) => {
  const res = await request.put("/api/settings/shortcuts", { data: { overrides: {} } });
  expect(res.ok()).toBe(true);
});

/** Holds the leader until the badges show (retrying while the page hydrates). */
async function holdLeader(page: Page, key: string) {
  const hints = page.getByTestId("nav-key-hint");
  await expect(async () => {
    await page.keyboard.up(key);
    await page.keyboard.press("Escape");
    await page.keyboard.down(key);
    await expect(hints).toHaveCount(NAV_HINTS, { timeout: 500 });
  }).toPass();
}

test("shortcuts: no hints at rest, badges while \\ is held, \\ t and a quick tap navigate, Esc and time end it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/stats");
  const aside = page.locator("aside");
  const hints = page.getByTestId("nav-key-hint");
  await expect(aside.getByRole("link", { name: "Transactions" })).toBeVisible();
  await expect(hints).toHaveCount(0);
  await expect(aside).not.toContainText(/\bG [TMAOSI,]\b/);

  // Held: every destination shows its second key (12px, text-3), the link names stay the plain labels.
  await holdLeader(page, "\\");
  await expect(aside.getByRole("link", { name: "Transactions" }).getByTestId("nav-key-hint")).toHaveAttribute("data-hint", "t");
  await expect(aside.getByRole("link", { name: "Rules" }).getByTestId("nav-key-hint")).toHaveAttribute("data-hint", "r");
  await expect(aside.getByRole("link", { name: "Settings" }).getByTestId("nav-key-hint")).toHaveAttribute("data-hint", ",");
  expect(await hints.first().evaluate((el) => getComputedStyle(el).fontSize)).toBe("12px");
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/\/transactions/);
  await expect(hints).toHaveCount(0);
  await page.keyboard.up("\\");

  // A long hold hides the badges on release.
  await page.keyboard.down("\\");
  await expect(hints).toHaveCount(NAV_HINTS);
  await page.waitForTimeout(600);
  await page.keyboard.up("\\");
  await expect(hints).toHaveCount(0);

  // A quick tap keeps the sequence (and the badges) for a moment: \ then m.
  await page.keyboard.press("\\");
  await expect(hints).toHaveCount(NAV_HINTS);
  await page.keyboard.press("m");
  await expect(page).toHaveURL(/\/stats$/);
  await expect(hints).toHaveCount(0);

  // Esc cancels; an unused tap runs out after about 1.5 s.
  await page.keyboard.press("\\");
  await expect(hints).toHaveCount(NAV_HINTS);
  await page.keyboard.press("Escape");
  await expect(hints).toHaveCount(0);
  await page.keyboard.press("\\");
  await expect(hints).toHaveCount(NAV_HINTS);
  await expect(hints).toHaveCount(0, { timeout: 2500 });
  await page.keyboard.press("a");
  await expect(page).toHaveURL(/\/stats$/);

  // Typing a backslash in a field is just typing.
  await page.goto("/transactions?month=2026-09");
  const search = page.locator("[data-page-search]");
  await search.click();
  await page.keyboard.press("\\");
  await expect(hints).toHaveCount(0);
  await expect(search).toHaveValue("\\");
});

test("shortcuts: Settings changes the leader to ;, ; a opens Assets, the sheet follows, reset to defaults", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings?tab=shortcuts");
  const section = page.locator("#shortcuts");
  await expect(section.getByRole("heading", { level: 2 })).toHaveText("Keyboard shortcuts");
  await expect(section).toContainText("Fixed");
  const leader = section.getByRole("button", { name: "Change the key for Leader key" });
  const stats = section.getByRole("button", { name: "Change the key for Stats" });
  await expect(leader).toHaveText("\\");

  // Capture: Esc cancels, Tab cannot be used, Backspace cannot clear the leader.
  await expect(async () => {
    await leader.click();
    await expect(leader).toHaveText("Press a key", { timeout: 500 });
  }).toPass();
  await page.keyboard.press("Escape");
  await expect(leader).toHaveText("\\");
  await leader.click();
  await page.keyboard.press("Tab");
  await expect(section.getByTestId("shortcut-leader")).toContainText("cannot be shortcuts");
  await leader.click();
  await page.keyboard.press("Backspace");
  await expect(leader).toHaveText("Press a key");
  await page.keyboard.press("Escape");

  // A clash shows on both rows and is not saved; fixing it clears both.
  await stats.click();
  await page.keyboard.press("t");
  await expect(section.getByTestId("shortcut-goStats")).toContainText("Also used by Transactions");
  await expect(section.getByTestId("shortcut-goTransactions")).toContainText("Also used by Stats");
  await stats.click();
  await page.keyboard.press("m");
  await expect(section.getByRole("alert")).toHaveCount(0);

  // The new leader applies at once: the go-to rows, the badges and the sheet.
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings/shortcuts") && r.request().method() === "PUT");
  await leader.click();
  await page.keyboard.press(";");
  expect((await saved).ok()).toBe(true);
  await expect(leader).toHaveText(";");
  await expect(section.getByTestId("shortcut-goAssets")).toContainText(";a");
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toContainText("press ;, then the letter");
  await expect(sheet.getByRole("listitem").filter({ hasText: "Assets" })).toContainText(";a");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.keyboard.press(";");
  await page.keyboard.press("a");
  await expect(page).toHaveURL(/\/assets$/);

  // Stored per user on the server: a reload keeps it, and "\" no longer leads.
  await page.reload();
  await holdLeader(page, ";");
  await page.keyboard.up(";");
  await page.keyboard.press("Escape");
  await page.keyboard.press("\\");
  await expect(page.getByTestId("nav-key-hint")).toHaveCount(0);

  // Reset to defaults.
  await page.goto("/settings?tab=shortcuts");
  await section.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(page.getByText("Shortcuts are back to the defaults")).toBeVisible();
  await expect(leader).toHaveText("\\");
  await expect(section.getByRole("button", { name: "Reset to defaults" })).toBeDisabled();
  await page.keyboard.press("\\");
  await page.keyboard.press("a");
  await expect(page).toHaveURL(/\/assets$/);
});

test("shortcuts: 中文 Settings rows and sheet; the phone tab bar still fits at 390", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "zh-CN", url: baseURL! }]);
  await page.goto("/settings#shortcuts");
  const section = page.locator("#shortcuts");
  await expect(section.getByRole("heading", { level: 2 })).toHaveText("键盘快捷键");
  await expect(section.getByTestId("shortcut-leader")).toContainText("引导键");
  await expect(section.getByRole("button", { name: "恢复默认" })).toBeDisabled();
  await expect(async () => {
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "键盘快捷键" })).toContainText("先按 \\，再按字母", { timeout: 500 });
  }).toPass();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/transactions?month=2026-09", "/settings"]) {
    await page.goto(path);
    const tabs = page.getByRole("navigation", { name: "主导航" });
    await expect(tabs.getByRole("link")).toHaveCount(4);
    const box = (await tabs.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});
