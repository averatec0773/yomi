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

/** The page does not scroll sideways at `width`. Polled: right after a navigation the layout may still be settling. */
export async function expectNoHScroll(page: Page, width: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

/** `locator`'s box lies within [left, right] on the x axis, polled like expectNoHScroll. */
export async function expectWithinX(locator: Locator, left: number, right: number): Promise<void> {
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box !== null && box.x >= left && box.x + box.width <= right;
    })
    .toBe(true);
}
