import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** "$1,234.56" → 123456 (minor units), from the element's text. */
async function minorOf(el: Locator): Promise<number> {
  const text = (await el.innerText()).replace(/[^\d.]/g, "");
  return Math.round(Number(text) * 100);
}

function roommateUsd(page: Page): Locator {
  return page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Settle up with 室友 in USD" }) });
}

async function openItemsDialog(page: Page): Promise<{ dialog: Locator; items: Locator }> {
  await roommateUsd(page).getByRole("button", { name: "Settle up with 室友 in USD" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Choose items" }).click();
  const list = dialog.getByTestId("settle-items");
  await expect(list).toBeVisible();
  return { dialog, items: list.locator("li input[type=checkbox]") };
}

test("settle: choose two of 室友's items with a CNY rate; they leave the open list", async ({ page }) => {
  await page.goto("/split");
  const hero = roommateUsd(page).locator(".text-hero");
  const before = await minorOf(hero);

  const { dialog, items } = await openItemsDialog(page);
  const n = await items.count();
  expect(n).toBeGreaterThan(2);
  await items.nth(0).check();
  await items.nth(1).check();
  await expect(dialog).toContainText("2 items selected");
  const amount = dialog.getByRole("textbox", { name: "Amount", exact: true });
  const sum = Math.round(Number(await amount.inputValue()) * 100);
  expect(sum).toBeGreaterThan(0);

  // Paid in CNY: typing the rate fills the amount received (one rounding, in fen).
  await dialog.getByRole("combobox", { name: "Actual currency" }).selectOption("CNY");
  await dialog.getByRole("textbox", { name: "Rate: CNY per 1 USD" }).fill("7.2");
  await expect(dialog.getByRole("textbox", { name: "Amount in CNY" })).toHaveValue((Math.round((sum * 72) / 10) / 100).toFixed(2));

  await dialog.getByRole("button", { name: /^Settle \$/ }).click();
  await expect(page.getByText(/^Settled 2 items with 室友/)).toBeVisible();
  await expect.poll(() => minorOf(hero)).toBe(before - sum);

  const again = await openItemsDialog(page);
  await expect(again.items).toHaveCount(n - 2);
  await page.keyboard.press("Escape");

  // The statement lists the settlement with its two items and the rate.
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const statement = page.getByRole("dialog").getByTestId("statement-items");
  await expect(statement).toContainText("Settled recently");
  await expect(statement).toContainText(/actually ¥[\d,.]+ at 7\.2/);
});

test("statement: a note for 室友 and the print view in English and 中文", async ({ page }) => {
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a note for 室友" }).first().click();
  await dialog.getByRole("textbox", { name: "Note for 室友" }).fill("Receipt in the kitchen drawer");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Note saved")).toBeVisible();
  await expect(dialog).toContainText("Receipt in the kitchen drawer");
  await expect(dialog.getByRole("button", { name: "Edit the note for 室友" })).toHaveCount(1);

  const href = await dialog.getByRole("link", { name: "Print preview" }).getAttribute("href");
  expect(href).toMatch(/^\/split\/statement\/print\?participantId=\d+&currency=USD&locale=en&show=shared,notes,settlements,payment$/);

  await page.goto(href!);
  await expect(page.getByRole("heading", { name: "Shared expenses with 室友" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Not settled yet" })).toBeVisible();
  await expect(page.getByText("Note: Receipt in the kitchen drawer")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeHidden();

  await page.goto(href!.replace("locale=en", "locale=zh-CN"));
  await expect(page.getByRole("heading", { name: "和室友的分摊账单" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存为 PDF" })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回对账单" })).toBeVisible();
  await expect(page.getByText("备注：Receipt in the kitchen drawer")).toBeVisible();

  // Printing keeps the statement and drops the buttons.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "保存为 PDF" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "和室友的分摊账单" })).toBeVisible();
});

test("statement scope: pick two items, print them, then settle exactly those", async ({ page }) => {
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: "Open only" })).toHaveAttribute("aria-checked", "true");
  const boxes = dialog.getByTestId("statement-checklist").locator("li input[type=checkbox]");
  await expect(boxes.first()).toBeVisible();
  expect(await boxes.count()).toBeGreaterThan(2);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(dialog.getByRole("radio", { name: "Selected (2)" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("statement-footer-totals")).toHaveText(/^2 items · open \$[\d,.]+$/);
  await expect(dialog.getByTestId("statement-scope-totals")).toHaveText(/^USD · in total \$[\d,.]+$/);
  const labels = [await boxes.nth(0).getAttribute("aria-label"), await boxes.nth(1).getAttribute("aria-label")].map((l) => l!.replace(/^Select /, ""));

  const href = await dialog.getByRole("link", { name: "Print preview" }).getAttribute("href");
  expect(href).toMatch(/^\/split\/statement\/print\?participantId=\d+&currency=USD&locale=en&scope=selected&items=\d+,\d+&show=[a-z,]+$/);
  await dialog.getByRole("button", { name: "Settle these" }).click();

  const settle = page.getByRole("dialog", { name: "Settle up with 室友 in USD" });
  await expect(settle.getByRole("radio", { name: "Choose items" })).toHaveAttribute("aria-checked", "true");
  await expect(settle).toContainText("2 items selected");
  for (const label of labels) await expect(settle.getByRole("checkbox", { name: label, exact: true })).toBeChecked();
  // Esc closes only the settle dialog: the statement is still there with the same two items ticked.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Statement for 室友" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Selected (2)" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto(href!);
  await expect(page.getByTestId("print-scope")).toHaveText("Selected 2 items");
  await expect(page.getByTestId("print-scope-total")).toBeVisible();
  await page.goto(href!.replace("locale=en", "locale=zh-CN"));
  await expect(page.getByTestId("print-scope")).toHaveText("所选 2 笔");
  await page.goto(href!.replace(/&scope=selected&items=[\d,]+/, "&scope=all"));
  await expect(page.getByTestId("print-scope")).toHaveText("All items");
  await expect(page.getByText(/^Settled on /).first()).toBeVisible();
});

test("statement options: names stay off by default, show them, and the print header lists them", async ({ page }) => {
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "All", exact: true }).click();
  const options = dialog.getByTestId("statement-options");
  // Collapsed by default, with a one-line summary of what is on.
  const toggle = options.getByRole("button", { name: /^Options/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("Who shared: Count only · Notes for them · Settlements");
  await toggle.click();
  await expect(options.getByRole("radio", { name: "Count only" })).toHaveAttribute("aria-checked", "true");
  await expect(options.getByRole("switch", { name: /^Show my share/ })).toHaveAttribute("aria-checked", "false");
  const items = dialog.getByTestId("statement-items");
  await expect(items).toContainText("Split 3 ways");
  await expect(items).not.toContainText("小李");

  await options.getByRole("radio", { name: "Names" }).click();
  await expect(items).toContainText("Split 3 ways with 小李");
  const href = await dialog.getByRole("link", { name: "Print preview" }).getAttribute("href");
  expect(href).toContain("&show=shared,names,notes,settlements,payment");
  await dialog.getByRole("radio", { name: "Text" }).click();
  await expect(dialog.getByText(/split 3 ways \(with 小李\)/).first()).toBeVisible();

  await page.goto(href!);
  await expect(page.getByTestId("print-shared-with")).toHaveText("Also shared with 小李");
  await expect(page.getByText("Split 3 ways (with 小李)").first()).toBeVisible();
  await page.goto(href!.replace("locale=en", "locale=zh-CN"));
  await expect(page.getByTestId("print-shared-with")).toHaveText("一起分摊的还有 小李");

  // Remembered for 室友 (and the panel stays open): the next statement opens with names on.
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  await expect(page.getByRole("dialog").getByRole("radio", { name: "Names" })).toHaveAttribute("aria-checked", "true");
});

test("statement print preview: the paper matches the screen by default; Print on white paper flips it and is remembered", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const dialog = page.getByRole("dialog");
  const options = dialog.getByTestId("statement-options");
  const toggle = options.getByRole("button", { name: /^Options/ });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(options.getByRole("switch", { name: /^Print on white paper/ })).toHaveAttribute("aria-checked", "false");
  const href = await dialog.getByRole("link", { name: "Print preview" }).getAttribute("href");
  expect(href).not.toContain("colors=");

  // Dark paper by default, in the app's own tokens, on screen and in print; the hero, sections and generated line.
  await page.goto(href!);
  const paper = page.locator("[data-print-paper]");
  const doc = page.locator("[data-print-doc]");
  const background = () => paper.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(doc).toHaveAttribute("data-print-colors", "screen");
  await expect(paper).not.toHaveClass(/\blight\b/);
  expect(await background()).toBe("rgb(26, 26, 24)");
  await expect(page.getByTestId("print-hero")).toContainText("室友 pays me");
  await expect(page.getByTestId("print-balance")).toHaveText(/^\$[\d,]+\.\d{2}$/);
  await expect(page.getByRole("heading", { name: "Not settled yet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Settled recently/ })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Their share" }).first()).toBeVisible();
  await expect(page.getByTestId("print-generated")).toHaveText(/^Generated by yomi on /);
  // The wider paper on desktop.
  expect(Math.round((await paper.boundingBox())!.width)).toBe(960);
  // Theme "System" on a dark OS: the print view pins dark on <html>, so a print preview that evaluates
  // prefers-color-scheme as light (Chrome) still prints the dark paper.
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await page.emulateMedia({ colorScheme: "light", media: "print" });
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(26, 26, 24)");
  expect(await background()).toBe("rgb(26, 26, 24)");
  // On paper the preview's card stays: the frame keeps a 1px border and 12px corners on each page fragment and sits
  // inside the document's own padding; a section without a table keeps its card the same way, and a table section's
  // card is drawn by the table (title row with the top corners, side lines on the cells, the tfoot's closing edge).
  const frame = (el: Element) => {
    const s = getComputedStyle(el);
    return [s.borderTopLeftRadius, s.borderBottomRightRadius, s.borderLeftWidth, s.borderRightWidth, s.boxDecorationBreak];
  };
  expect(await paper.evaluate(frame)).toEqual(["12px", "12px", "1px", "1px", "clone"]);
  for (const card of await page.locator(".print-card").all()) {
    const hasTable = (await card.locator(".print-table").count()) > 0;
    if (!hasTable) expect(await card.evaluate(frame)).toEqual(["12px", "12px", "1px", "1px", "clone"]);
    else {
      const title = card.locator(".print-head-title th");
      expect(await title.evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderTopWidth])).toEqual(["12px", "1px"]);
      const close = await card.locator(".print-close td").evaluate((el) => {
        const s = getComputedStyle(el, "::after");
        return [s.borderBottomLeftRadius, s.borderBottomWidth, s.borderLeftWidth];
      });
      expect(close).toEqual(["12px", "1px", "1px"]);
    }
  }
  expect(await page.locator(".print-card .print-table").count()).toBeGreaterThan(0);
  const box = (await paper.boundingBox())!;
  expect(box.x).toBeGreaterThan(0);
  expect(box.y).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page.emulateMedia({ colorScheme: "dark", media: "screen" });

  // The toolbar switch turns the paper white (colors=light) and remembers it for 室友.
  await page.getByRole("switch", { name: "Print on white paper" }).click();
  await expect(page).toHaveURL(/&colors=light$/);
  await expect(doc).toHaveAttribute("data-print-colors", "light");
  await expect(paper).toHaveClass(/\blight\b/);
  expect(await background()).toBe("rgb(255, 255, 255)");
  await page.goto(`${href!.replace("show=", "scope=all&show=")}&colors=light`);
  await expect(page.getByRole("heading", { name: "Already settled" })).toBeVisible();

  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const again = page.getByRole("dialog");
  const white = again.getByRole("switch", { name: /^Print on white paper/ });
  await expect(white).toHaveAttribute("aria-checked", "true");
  expect(await again.getByRole("link", { name: "Print preview" }).getAttribute("href")).toMatch(/&colors=light$/);
  // Off again in the dialog: back to the screen colors.
  await white.click();
  const screen = await again.getByRole("link", { name: "Print preview" }).getAttribute("href");
  expect(screen).not.toContain("colors=");
  await page.goto(screen!);
  await expect(doc).toHaveAttribute("data-print-colors", "screen");
  // Back to statement falls back to /split when no statement tab opened this one.
  await page.getByRole("link", { name: "Back to statement" }).click();
  await expect(page).toHaveURL(/\/split$/);
});

test("display name: set in Settings, it labels my share on the statement and its print preview", async ({ page, request }) => {
  await page.goto("/settings?tab=profile");
  const name = page.getByRole("textbox", { name: "Your name" });
  await name.fill("  Sam ");
  await name.press("Enter");
  await expect(page.getByText("Name saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Your name" })).toHaveValue("Sam");

  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const dialog = page.getByRole("dialog");
  const options = dialog.getByTestId("statement-options");
  const toggle = options.getByRole("button", { name: /^Options/ });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await options.getByRole("switch", { name: /^Show my share/ }).click();
  await expect(dialog.getByTestId("statement-items")).toContainText(/Sam's share \$[\d,]+\.\d{2}/);
  const href = await dialog.getByRole("link", { name: "Print preview" }).getAttribute("href");
  expect(href).toContain("myshare");
  await page.goto(href!);
  await expect(page.getByTestId("print-my-share-head").first()).toHaveText("Sam's share");
  await page.goto(href!.replace("locale=en", "locale=zh-CN"));
  await expect(page.getByTestId("print-my-share-head").first()).toHaveText("Sam的份额");

  // A name of about 20 characters keeps the header within two lines on the 960px preview and on A4 paper (about 734px
  // between the page margins).
  await request.put("/api/settings/profile", { data: { displayName: "Alexandra Whitfield" } });
  await page.goto(href!);
  const head = page.getByTestId("print-my-share-head").first();
  await expect(head).toHaveText("Alexandra Whitfield's share");
  const lines = () =>
    head.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el.firstChild!);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
  expect(await lines()).toBe(2);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 734, height: 900 });
  await page.emulateMedia({ media: "print" });
  expect(await lines()).toBe(2);
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize(viewport);

  // Cleared: back to "My share".
  await page.goto("/settings?tab=profile");
  const cleared = page.getByRole("textbox", { name: "Your name" });
  await cleared.fill("");
  await cleared.blur();
  await expect(page.getByText(/^Name removed/)).toBeVisible();
  await page.goto(href!);
  await expect(page.getByTestId("print-my-share-head").first()).toHaveText("My share");
});

test("statement: settle these on top of the statement; cancel returns, settling refreshes the items", async ({ page }) => {
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const statement = page.getByRole("dialog", { name: "Statement for 室友" });
  const boxes = statement.getByTestId("statement-checklist").locator("li input[type=checkbox]");
  await expect(boxes.first()).toBeVisible();
  const n = await boxes.count();
  await boxes.nth(0).check();

  await statement.getByRole("button", { name: "Settle these" }).click();
  const settle = page.getByRole("dialog", { name: "Settle up with 室友 in USD" });
  await expect(settle).toContainText("1 item selected");
  await settle.getByRole("button", { name: "Cancel" }).click();
  await expect(settle).toBeHidden();
  await expect(statement.getByRole("radio", { name: "Selected (1)" })).toHaveAttribute("aria-checked", "true");

  await statement.getByRole("button", { name: "Settle these" }).click();
  await settle.getByRole("button", { name: /^Settle \$/ }).click();
  await expect(page.getByText(/^Settled 1 item with 室友/)).toBeVisible();
  await expect(settle).toBeHidden();
  await expect(statement).toBeVisible();
  await expect(boxes).toHaveCount(n - 1);
  await expect(statement.getByRole("radio", { name: "Open only" })).toHaveAttribute("aria-checked", "true");
});
