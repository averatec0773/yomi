import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// The demo ledger (packages/core/src/cli/demo.ts) has five pasted alerts on the made-up ICBC card 3141 and that card's
// statement through Sep 26: one alert is confirmed, one hold has two equal statement rows (ambiguous), one hold came in
// 15% higher (near miss), one alert has no row though the statement covers its day (stale), and the last alert is
// after the statement (provisional). Every test leaves the queue as it found it (Undo).

/** Opens the review sheet from the line on Transactions (retrying while the page hydrates). */
async function openReview(page: Page): Promise<Locator> {
  const sheet = page.getByRole("dialog", { name: "Review captures" });
  await expect(async () => {
    await page.getByTestId("review-line").getByRole("button", { name: "Review" }).click();
    await expect(sheet).toBeVisible({ timeout: 1_000 });
  }).toPass();
  return sheet;
}

const item = (sheet: Locator, type: string) => sheet.locator(`[data-testid=review-item][data-type=${type}]`);

test("captures: the Transactions line, row labels and totals that say what rests on captures", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/transactions?month=2026-09");
  await expect(page.getByTestId("review-line")).toContainText("3 captures need a look");
  await expect(page.getByTestId("provisional-note")).toHaveText("incl. $32.22 provisional (2) · 2 card holds not counted, $59.99");
  const heb = page.getByRole("row").filter({ hasText: "H-E-B" }).filter({ hasText: "Provisional" });
  await expect(heb).toContainText(/Provisional\s*·\s*ICBC credit card 3141 · from SMS/);
  const holds = page.getByRole("row").filter({ hasText: "Card hold" });
  await expect(holds).toHaveCount(2);
  await expect(holds.first()).toContainText("Card hold (pre-authorisation)");

  // Analysis says the same under its hero.
  await page.goto("/analysis?preset=this_month");
  await expect(page.getByRole("region", { name: "USD stats" }).getByTestId("provisional-note")).toHaveText(
    "incl. $32.22 provisional (2) · 2 card holds not counted, $59.99",
  );
});

test("captures: the review sheet resolves each kind of item, with Undo", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/transactions?month=2026-09");
  const sheet = await openReview(page);
  await expect(sheet.getByTestId("review-item")).toHaveCount(3);

  const ambiguous = item(sheet, "ambiguous");
  await expect(ambiguous).toContainText("Which statement row is this?");
  await expect(ambiguous).toContainText("SMS · card 3141 · Sep 11, 12:26 · $28.79 card hold");
  await expect(ambiguous.getByRole("radio")).toHaveCount(2);
  await expect(ambiguous.getByRole("radio").first()).toBeChecked();
  await expect(ambiguous).toContainText(/amount\s*card\s*1 day later/);
  const nearMiss = item(sheet, "near_miss");
  await expect(nearMiss).toContainText("Amount differs");
  await expect(nearMiss).toContainText("+$4.67, tip?");
  const stale = item(sheet, "stale");
  await expect(stale).toContainText("No statement row yet");
  await expect(stale).toContainText("statement covers up to Sep 26");

  // Link the hold to its second candidate: it leaves the queue, the line counts 2; Undo brings it back.
  await ambiguous.getByRole("radio").nth(1).check();
  await ambiguous.getByRole("button", { name: "Link selected" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone")).toBeVisible();
  await expect(sheet.getByTestId("review-item")).toHaveCount(3);

  // Keep as final: the stale alert becomes a normal row and the line counts 2.
  await stale.getByRole("button", { name: "Keep as final" }).click();
  await expect(sheet.getByTestId("review-item")).toHaveCount(2);
  await expect(page.getByTestId("review-line")).toContainText("2 captures need a look");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(sheet.getByTestId("review-item")).toHaveCount(3);
  await expect(page.getByTestId("review-line")).toContainText("3 captures need a look");

  // Select: the bulk bar offers only what every selected item allows (a near miss cannot be kept as final).
  await sheet.getByRole("button", { name: "Select", exact: true }).click();
  await nearMiss.getByRole("checkbox", { name: "Select this item" }).check();
  await stale.getByRole("checkbox", { name: "Select this item" }).check();
  const bar = sheet.getByRole("toolbar", { name: "Bulk actions" });
  await expect(bar).toContainText("2 selected");
  await expect(bar.getByRole("button", { name: "Keep as final" })).toHaveCount(0);
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect(sheet.getByTestId("review-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(sheet.getByTestId("review-item")).toHaveCount(3);
});

test("captures: a queue that fails to load says so instead of loading forever, and Try again loads it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/review", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
  await page.goto("/transactions?month=2026-09");
  const sheet = await openReview(page);
  await expect(sheet).toContainText("The review queue could not load.");
  await expect(sheet.getByTestId("review-loading")).toHaveCount(0);
  await page.unroute("**/api/review");
  await sheet.getByRole("button", { name: "Try again" }).click();
  await expect(sheet.getByTestId("review-item")).toHaveCount(3);
});

test("captures: on a phone the sheet fills the screen; the details show the capture", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/transactions?month=2026-09");
  const sheet = await openReview(page);
  const box = await sheet.boundingBox();
  expect(box?.height).toBeGreaterThan(800);
  expect(box?.width).toBeGreaterThan(370);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // The confirmed alert (shown with closed and duplicates) says which statement row replaced it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/transactions?q=42.16&show=all");
  const sms = page.getByRole("row").filter({ hasText: "from SMS" });
  await sms.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Source details" }).click();
  await expect(page.getByTestId("tx-capture-state")).toContainText(/Superseded by ICBC credit card row #\d+/);
});
