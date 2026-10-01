import { expect, test } from "./fixtures";

test("phone: the bulk bar sits above the tab bar and clears the selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/transactions?month=2026-09");
  const row = page.getByRole("row").first();
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select" }).click();

  const bar = page.getByRole("toolbar", { name: "Bulk actions" });
  await expect(bar).toContainText("1 selected");
  const tabs = page.getByRole("navigation", { name: "Main navigation" });
  const barBox = (await bar.boundingBox())!;
  const tabsBox = (await tabs.boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(tabsBox.y);
  // The bar's actions are reachable (not covered) and the tab bar's Add steps aside.
  await expect(bar.getByRole("button", { name: "Split…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a transaction" })).toBeHidden();

  await bar.getByRole("button", { name: "Clear selection" }).click();
  await expect(bar).toBeHidden();
  await expect(page.getByRole("button", { name: "Add a transaction" })).toBeVisible();
});

test("transactions: custom range, stepping by its length, CSV follows, month alias still works", async ({ page }) => {
  await page.goto("/transactions?month=2026-08");
  const bar = page.getByRole("navigation", { name: "Period" });
  await expect(bar).toContainText("August 2026");

  await bar.getByRole("button", { name: /^Choose a period/ }).click();
  await page.getByRole("menuitem", { name: "Custom range" }).click();
  const form = page.getByRole("form", { name: "Custom range" });
  await form.getByLabel("Start date").fill("2026-09-05");
  await form.getByLabel("End date").fill("2026-09-20");
  await form.getByRole("button", { name: "View" }).click();
  await expect(page).toHaveURL(/\/transactions\?from=2026-09-05&to=2026-09-20$/);
  await expect(bar).toContainText("Sep 5 – 20, 2026");
  await expect(page.getByRole("region", { name: "Your share, Sep 5 – 20, 2026" })).toBeVisible();
  await expect(page.getByRole("row").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", /from=2026-09-05&to=2026-09-20/);

  // Filters stay on when the period steps; a 16-day range steps by 16 days.
  await page.getByRole("button", { name: "Not split" }).click();
  await expect(page).toHaveURL(/unsplit=1/);
  await bar.getByRole("link", { name: "Next period" }).click();
  await expect(page).toHaveURL(/unsplit=1&from=2026-09-21&to=2026-10-06|from=2026-09-21&to=2026-10-06.*unsplit=1/);
  await expect(page.getByRole("button", { name: "Not split" })).toHaveAttribute("aria-pressed", "true");

  // Presets land on ?preset= and the menu marks the active one.
  await bar.getByRole("button", { name: /^Choose a period/ }).click();
  await page.getByRole("menuitem", { name: "This year" }).click();
  await expect(page).toHaveURL(/preset=this_year/);
});
