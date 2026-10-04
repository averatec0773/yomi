import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// The demo ledger (packages/core/src/cli/demo.ts) has three partial repayments from friends (室友 as 阿杰, 小李) and
// transfers with Momo, who is not a person in Split. Naming Momo as one of my names in Settings > Profile turns those
// into own-account transfer items. The test leaves the ledger as it found it (Undo, and the name removed).

async function openReview(page: Page): Promise<Locator> {
  const sheet = page.getByRole("dialog", { name: "Needs a look" });
  await expect(async () => {
    await page.getByTestId("review-line").getByRole("button", { name: "Review" }).click();
    await expect(sheet).toBeVisible({ timeout: 1_000 });
  }).toPass();
  return sheet;
}

const items = (sheet: Locator, type: string) => sheet.locator(`[data-testid=review-item][data-type=${type}]`);

test("income review: my names make own-transfer items, repayments settle, each action and the bulk confirm undo", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings?tab=profile");
  const names = page.getByTestId("transfer-names");
  await expect(names).toContainText("No names yet.");
  await names.locator("select").selectOption("alipay");
  await names.getByTestId("transfer-name-input").fill("Momo");
  await names.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Added Momo")).toBeVisible();
  await expect(names.getByRole("listitem")).toHaveText(/Alipay\s*Momo/);

  await page.goto("/transactions?month=2026-09");
  await expect(page.getByTestId("review-line")).toContainText("9 items need a look");
  const sheet = await openReview(page);
  const own = items(sheet, "own_transfer");
  const repay = items(sheet, "repayment");
  await expect(own).toHaveCount(3);
  await expect(repay).toHaveCount(3);

  // One own-account transfer: confirmed, then Undo brings it back.
  const alipay = own.filter({ hasText: "Sep 10" });
  await expect(alipay).toContainText("Between your accounts?");
  await expect(alipay).toContainText("Alipay · Alipay balance · Momo · Sep 10 · +¥88.00");
  await expect(alipay).toContainText("Sent from or to one of your names");
  await alipay.getByRole("button", { name: "It's a transfer" }).click();
  await expect(page.getByText("Marked as a transfer between your accounts")).toBeVisible();
  await expect(own).toHaveCount(2);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(own).toHaveCount(3);

  // A repayment: Settle records it, Undo deletes the settlement.
  const li = repay.filter({ hasText: "小李" });
  await expect(li).toContainText("Paid back?");
  await expect(li).toContainText("Counts as 小李 paying back ¥66.00");
  await expect(li).toContainText("After it: to settle with 小李 ¥127.00");
  await expect(li).toContainText(/Name matches\s*Part of what is open/);
  await li.getByRole("button", { name: "Settle" }).click();
  await expect(page.getByText("Recorded 小李 paying you back")).toBeVisible();
  await expect(repay).toHaveCount(2);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(repay).toHaveCount(3);

  // Bulk: only own-account transfers can be confirmed together.
  await sheet.getByRole("button", { name: "Select", exact: true }).click();
  await expect(repay.first().getByRole("checkbox")).toBeDisabled();
  for (const box of await own.getByRole("checkbox", { name: "Select this item" }).all()) await box.check();
  const bar = sheet.getByRole("toolbar", { name: "Bulk actions" });
  await expect(bar).toContainText("3 selected");
  await bar.getByRole("button", { name: "Mark as transfers" }).click();
  await expect(page.getByText("Marked 3 transfers between your accounts")).toBeVisible();
  await expect(own).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(own).toHaveCount(3);
  await page.keyboard.press("Escape");

  // Remove the name again: the queue is back to captures and repayments.
  await page.goto("/settings?tab=profile");
  await names.getByRole("button", { name: "Remove Momo" }).click();
  await expect(names).toContainText("No names yet.");
  await page.goto("/transactions?month=2026-09");
  await expect(page.getByTestId("review-line")).toContainText("6 items need a look");
});
