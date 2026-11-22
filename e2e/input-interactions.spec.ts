import { expect, test } from "./fixtures";

for (const ime of [
  { name: "composing", isComposing: true, keyCode: 13 },
  { name: "Safari composition commit", isComposing: false, keyCode: 229 },
]) {
  test(`transaction notes: ${ime.name} Enter keeps editing until a separate Enter saves`, async ({ page }) => {
    await page.goto("/transactions?month=2026-09");
    const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Split", exact: true }) }).first();
    const id = await row.getAttribute("data-tx-id");
    await row.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /^(Add|Edit) note$/ }).click();
    const input = row.getByRole("textbox", { name: "Note", exact: true });
    const original = await input.inputValue();
    await input.fill("English");
    let writes = 0;
    page.on("request", (r) => {
      if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/transactions/${id}`) writes++;
    });
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: ime.isComposing, keyCode: ime.keyCode });
    await expect(input).toBeFocused();
    expect(writes).toBe(0);
    await input.dispatchEvent("keydown", { key: "Escape", isComposing: true });
    await expect(input).toBeFocused();
    const note = `English note ${ime.name} complete`;
    await input.fill(note);
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/transactions/${id}`);
    await input.press("Enter");
    expect((await saved).ok()).toBe(true);
    await expect(input).toHaveCount(0);
    await expect(row).toContainText(note);
    expect((await page.request.patch(`/api/transactions/${id}`, { data: { note: original || null } })).ok()).toBe(true);
  });
}

test("phone: split settings and row menu keep the split popover open", async ({ page }) => {
  await page.setViewportSize({ width: 580, height: 800 });
  await page.goto("/transactions?month=2026-08&unsplit=1");
  const trigger = page.getByRole("button", { name: "Split settings", exact: true }).last();
  const id = await trigger.evaluate((el) => el.closest("[data-tx-id]")!.getAttribute("data-tx-id"));
  const row = page.locator(`[data-tx-id="${id}"]`);
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  for (let i = 0; i < 3; i++) {
    await row.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Split", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "Me", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("phone: an existing split keeps its click target while the page hydrates", async ({ page }) => {
  await page.setViewportSize({ width: 580, height: 800 });
  let releaseScripts!: () => void;
  const scripts = new Promise<void>((resolve) => { releaseScripts = resolve; });
  await page.route("**/_next/static/**/*.js*", async (route) => {
    await scripts;
    await route.continue();
  });
  try {
    await page.goto("/transactions?month=2026-09", { waitUntil: "commit" });
    const trigger = page.getByRole("button", { name: /^Split with .+, open to adjust$/ }).first();
    await trigger.scrollIntoViewIfNeeded();
    const id = await trigger.evaluate((el) => el.closest("[data-tx-id]")!.getAttribute("data-tx-id"));
    const row = page.locator(`[data-tx-id="${id}"]`);
    await expect(row.getByRole("button", { name: /^Category:/, includeHidden: true })).toBeHidden();
    const box = (await trigger.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    releaseScripts();
    await expect(row.getByRole("checkbox")).toHaveCount(0);
    await page.mouse.up();
    await expect(page.getByRole("dialog").getByRole("checkbox", { name: "Me", exact: true })).toBeDisabled();
  } finally {
    releaseScripts();
  }
});
