import { type BrowserContext, expect, type Locator, type Page, test as base } from "@playwright/test";
import { E2E_NOW } from "../playwright.config";

export { expect } from "@playwright/test";

/**
 * Start the browser clock at E2E_NOW, the instant the servers also pin (YOMI_E2E_NOW), so "today", "this month" and
 * relative times match the fixed demo ledger whatever the real date. Time still advances from there.
 */
export async function pinClock(context: BrowserContext): Promise<void> {
  await context.clock.install({ time: new Date(E2E_NOW) });
}

/** Every spec imports `test` from here: its `context` (and so `page`) runs on the pinned clock. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await pinClock(context);
    await use(context);
  },
});

/**
 * Hover `row` and click its split popover `trigger` until the popover shows. Right after a page load every row's
 * trigger is replaced once (Radix's PopoverTrigger rewraps itself when the row's PopoverAnchor mounts, in an effect),
 * and a click that lands on the old node is lost. Retrying only the opening keeps every assertion that follows.
 */
export async function openRowPopover(page: Page, row: Locator, trigger: Locator): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await row.hover();
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();
  return dialog;
}
