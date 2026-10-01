import type { Page } from "@playwright/test";
import { expect, openRowPopover, test } from "./fixtures";

const ACCEPT = /^Accept \d+ suggestions?$/;

async function acceptCount(page: Page): Promise<number> {
  const text = await page.getByRole("button", { name: ACCEPT }).innerText();
  return Number(/\d+/.exec(text)![0]);
}

/** Rows whose dashed suggestion marker is showing. */
const suggestedRows = (page: Page) => page.getByRole("row").filter({ has: page.getByRole("button", { name: "Suggestion options" }) });

test("suggestions: category reason on the marker and in the popover, accept all, then Undo", async ({ page }) => {
  await page.goto("/transactions?month=2026-08&unsplit=1");
  const n = await acceptCount(page);
  expect(n).toBeGreaterThan(1);
  await expect(suggestedRows(page)).toHaveCount(n);

  // The demo splits almost every grocery row with 室友, so a grocery merchant without its own rule is suggested by category.
  const byCategory = page.getByRole("button", { name: "Split with 室友" }).and(page.locator('[title*="of split Groceries are with 室友"]')).first();
  await expect(byCategory).toBeVisible();
  const row = page.getByRole("row").filter({ has: byCategory }).first();
  await openRowPopover(page, row, row.getByRole("button", { name: "Split settings" }));
  await expect(page.getByTestId("split-suggestion-reason")).toContainText(/\d+% of split Groceries are with 室友/);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: ACCEPT }).click();
  await expect(page.getByText(`Split ${n} suggested rows`)).toBeVisible();
  await expect(page.getByRole("button", { name: ACCEPT })).toHaveCount(0);
  await expect(suggestedRows(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone")).toBeVisible();
  await page.reload();
  expect(await acceptCount(page)).toBe(n);
});

test("suggestions: 'Not this one' hides one row's suggestion, Undo brings it back", async ({ page }) => {
  await page.goto("/transactions?month=2026-07");
  const n = await acceptCount(page);
  const row = suggestedRows(page).first();
  const id = await row.getAttribute("data-tx-id");
  await row.getByRole("button", { name: "Suggestion options" }).click();
  await page.getByRole("menuitem", { name: "Not this one" }).click();
  const same = page.locator(`[role=row][data-tx-id="${id}"]`);
  await expect(same.getByRole("button", { name: "Suggestion options" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: ACCEPT })).toHaveText(n - 1 === 1 ? "Accept 1 suggestion" : `Accept ${n - 1} suggestions`);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(same.getByRole("button", { name: "Suggestion options" })).toBeVisible();
  await page.reload();
  expect(await acceptCount(page)).toBe(n);
});
