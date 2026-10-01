import { rmSync, writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { CARD, qrCardPng } from "./qr-card";

/** Fictional payload on example.com; the card around it names "Alex Demo" in plain text. */
const PAYLOAD = "https://example.com/pay/zelle/alex-demo?ref=e2e-original";

async function scan(el: Locator): Promise<string | null> {
  const png = PNG.sync.read(await el.screenshot());
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
}

async function roommateId(page: Page): Promise<number> {
  const { balances } = (await (await page.request.get("/api/split/balances")).json()) as { balances: { participantId: number; name: string; currency: string }[] };
  return balances.find((b) => b.name === "室友" && b.currency === "USD")!.participantId;
}

test.afterEach(async ({ request }) => {
  expect((await request.put("/api/settings/payment-methods", { data: { methods: [] } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { email: null } })).ok()).toBe(true);
});

test("original QR card: fitted crop, keyboard adjustments, scan check, Original on the statement, back to Clean without a new import", async ({
  page,
  request,
}, testInfo) => {
  expect((await request.put("/api/settings/payment-methods", { data: { methods: [] } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { email: "alex@example.com" } })).ok()).toBe(true);
  await page.goto("/settings#profile");
  const cardFile = testInfo.outputPath("qr-card.png");
  writeFileSync(cardFile, await qrCardPng(page, PAYLOAD));

  const section = page.getByTestId("payment-methods");
  await section.getByRole("button", { name: "Add a payment method" }).click();
  const dialog = page.getByRole("dialog");
  // A new Zelle shows the profile email, ticked.
  await expect(dialog.getByRole("checkbox", { name: "Show my email (alex@example.com)" })).toBeChecked();
  await dialog.getByTestId("qr-file").setInputFiles(cardFile);
  await expect(dialog.getByTestId("qr-payload")).toHaveText(PAYLOAD);

  // Two previews side by side, Clean chosen.
  const display = dialog.getByTestId("qr-display");
  await expect(display.getByRole("radio", { name: "Clean" })).toBeChecked();
  await expect(display.getByRole("radio", { name: "Original" })).not.toBeChecked();
  expect(await scan(dialog.getByTestId("settings-qr"))).toBe(PAYLOAD);

  // Original opens the crop step, fitted to the card around the QR (its edges found on the grey screen).
  await display.getByRole("radio", { name: "Original" }).click();
  await expect(dialog).toHaveAccessibleName("Crop your QR card");
  const box = dialog.getByTestId("qr-crop-box");
  const { card } = CARD;
  await expect(box).toHaveAttribute("data-rect", `${card.x},${card.y},${card.width},${card.height}`);
  await expect(box).toBeFocused();
  // Arrows move the box (Shift: 10 px); Esc goes back to the form without applying.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(box).toHaveAttribute("data-rect", `${card.x - 11},${card.y},${card.width},${card.height}`);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveAccessibleName("Add a payment method");
  await expect(display.getByRole("radio", { name: "Clean" })).toBeChecked();

  // Again: the top edge's handle moves the top down by 20 px, then Reset, then again, and Use this crop.
  await display.getByRole("radio", { name: "Original" }).click();
  const top = dialog.getByRole("button", { name: "Top edge" });
  await top.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(box).toHaveAttribute("data-rect", `${card.x},${card.y + 20},${card.width},${card.height - 20}`);
  await dialog.getByRole("button", { name: "Reset" }).click();
  await expect(box).toHaveAttribute("data-rect", `${card.x},${card.y},${card.width},${card.height}`);
  await top.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await dialog.getByRole("button", { name: "Use this crop" }).click();
  await expect(dialog).toHaveAccessibleName("Add a payment method");
  await expect(display.getByRole("radio", { name: "Original" })).toBeChecked();
  await expect(dialog.locator("[data-scan]")).toHaveAttribute("data-scan", "ok");
  await expect(dialog.getByTestId("qr-scan-warning")).toBeHidden();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(section.getByTestId("payment-method").first()).toContainText("alex@example.com · Original QR card · USD");

  // Stored beside the payload: the crop at 600 px wide as WebP.
  const stored = (await (await request.get("/api/settings/payment-methods")).json()).methods[0];
  expect(stored).toMatchObject({ qr: PAYLOAD, display: "original", original: { width: 600, height: Math.round(((card.height - 20) * 600) / card.width) } });
  expect(stored.original.dataUrl).toMatch(/^data:image\/webp;base64,/);

  // The statement preview shows the image at its own ratio, 160 px wide, and it scans.
  const id = await roommateId(page);
  await page.goto(`/split/statement/print?participantId=${id}&currency=USD&locale=en&show=payment`);
  const qr = page.getByTestId("print-pay").getByTestId("pay-qr");
  await expect(qr).toHaveJSProperty("tagName", "IMG");
  await expect(qr).toHaveAttribute("src", stored.original.dataUrl);
  const size = (await qr.boundingBox())!;
  expect(Math.round(size.width)).toBe(160);
  // Its own aspect ratio (the 1px hairline sits inside the 160px).
  expect(Math.abs(size.height - (158 * stored.original.height) / 600 - 2)).toBeLessThan(1);
  expect(await scan(qr)).toBe(PAYLOAD);
  await expect(page.getByTestId("print-pay")).toContainText("Zelle QR code");

  // Back to Clean without a new import: the drawn QR returns, the crop stays stored for later.
  await page.goto("/settings#profile");
  await section.getByRole("button", { name: "Edit Zelle" }).click();
  const edit = page.getByRole("dialog", { name: "Edit payment method" });
  await expect(edit.getByTestId("qr-display").getByRole("radio", { name: "Original" })).toBeChecked();
  await edit.getByTestId("qr-display").getByRole("radio", { name: "Clean" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  const clean = (await (await request.get("/api/settings/payment-methods")).json()).methods[0];
  expect(clean).toMatchObject({ display: "clean", original: stored.original });
  await page.goto(`/split/statement/print?participantId=${id}&currency=USD&locale=en&show=payment`);
  await expect(page.getByTestId("print-pay").getByTestId("pay-qr")).toHaveJSProperty("tagName", "svg");

  // A new import resets to Clean; a crop that cuts the code gets a calm warning with a one-click switch to Clean.
  await page.goto("/settings#profile");
  await section.getByRole("button", { name: "Edit Zelle" }).click();
  const again = page.getByRole("dialog");
  await again.getByTestId("qr-file").setInputFiles(cardFile);
  const choice = again.getByTestId("qr-display");
  await expect(choice.getByRole("radio", { name: "Clean" })).toBeChecked();
  await choice.getByRole("radio", { name: "Original" }).click();
  // The bottom edge up to the middle of the QR.
  await again.getByRole("button", { name: "Bottom edge" }).focus();
  const cut = card.y + card.height - (CARD.qr.y + CARD.qr.side / 2);
  for (let i = 0; i < Math.ceil(cut / 10); i++) await page.keyboard.press("Shift+ArrowUp");
  await again.getByRole("button", { name: "Use this crop" }).click();
  const warning = again.getByTestId("qr-scan-warning");
  await expect(warning).toHaveText(/This crop may not scan when printed\. Clean is safer\./);
  await warning.getByRole("button", { name: "Use Clean" }).click();
  await expect(choice.getByRole("radio", { name: "Clean" })).toBeChecked();
  await expect(warning).toBeHidden();

  // Remove QR code removes both.
  await again.getByRole("button", { name: "Remove QR code" }).click();
  await expect(again.getByTestId("qr-display")).toBeHidden();
  await again.getByRole("button", { name: "Save" }).click();
  await expect(again).toBeHidden();
  const removed = (await (await request.get("/api/settings/payment-methods")).json()).methods[0];
  expect(removed).toMatchObject({ qr: null, original: null, display: "clean", email: null, useProfileEmail: true });

  rmSync(cardFile);
});
