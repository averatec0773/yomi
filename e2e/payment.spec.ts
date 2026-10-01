import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";

/** Fictional payload: a made-up link on example.com, generated as a PNG at test time. */
const PAYLOAD = "https://example.com/pay/zelle/alex-demo?ref=e2e";

/** The text of the QR code an element shows, read back from a screenshot with jsQR. */
async function scan(el: Locator): Promise<string | null> {
  const png = PNG.sync.read(await el.screenshot());
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
}

function roommateUsd(page: Page): Locator {
  return page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Settle up with 室友 in USD" }) });
}

test("payment methods: add Zelle (email and phone) with a QR image, My payment details on the statement and its print preview, hide it per person", async ({
  page,
  request,
}, testInfo) => {
  const qrFile = testInfo.outputPath("zelle-qr.png");
  await QRCode.toFile(qrFile, PAYLOAD, { width: 320, margin: 2 });
  const blankFile = testInfo.outputPath("no-qr.png");
  const blank = new PNG({ width: 64, height: 64 });
  blank.data.fill(255);
  writeFileSync(blankFile, PNG.sync.write(blank));

  expect((await request.put("/api/settings/payment-methods", { data: { methods: [] } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { email: "alex@example.com", phone: "+1 202 555 0143" } })).ok()).toBe(true);
  await page.goto("/settings#profile");
  const section = page.getByTestId("payment-methods");
  await section.getByRole("button", { name: "Add a payment method" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a payment method" });
  await expect(dialog).toContainText("In your bank app, open Zelle");
  await dialog.getByRole("textbox", { name: "Label (optional)" }).fill("Zelle (Chase)");
  // Zelle shows the profile's email and phone (no username), both ticked; with neither, it asks for one or a QR code.
  const contact = dialog.getByTestId("payment-contact");
  await expect(contact.getByRole("textbox")).toHaveCount(0);
  const showEmail = contact.getByRole("checkbox", { name: "Show my email (alex@example.com)" });
  const showPhone = contact.getByRole("checkbox", { name: "Show my phone (202-555-0143)" });
  await expect(showEmail).toBeChecked();
  await expect(showPhone).toBeChecked();
  await showEmail.uncheck();
  await showPhone.uncheck();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Show your email or phone, or add a QR code.");
  // An override is checked like before; going back to the profile drops it.
  await contact.getByRole("button", { name: "Use a different email" }).click();
  await contact.getByRole("textbox", { name: "Email for this method" }).fill("alex@example");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That email address does not look complete.");
  await contact.getByRole("button", { name: "Use my profile email" }).click();
  await expect(showEmail).toBeChecked();
  await showPhone.check();
  await expect(dialog.getByRole("alert")).toBeHidden();
  await expect(dialog.getByRole("checkbox", { name: "USD" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "CNY" })).not.toBeChecked();

  // An image without a code: a calm inline message, the dialog stays open.
  await dialog.getByTestId("qr-file").setInputFiles(blankFile);
  await expect(dialog.getByTestId("qr-error")).toHaveText("Could not read a QR code in that image. Try a tighter crop.");
  // The generated QR image: only its text is kept, and it is drawn again from that text.
  await dialog.getByTestId("qr-file").setInputFiles(qrFile);
  await expect(dialog.getByTestId("qr-payload")).toHaveText(PAYLOAD);
  await expect(dialog.getByTestId("qr-error")).toBeHidden();
  expect(await scan(dialog.getByTestId("settings-qr"))).toBe(PAYLOAD);

  // ⌘V with an image while the dialog is open reads it the same way.
  await dialog.getByRole("button", { name: "Remove QR code" }).click();
  await expect(dialog.getByTestId("qr-drop")).toBeVisible();
  const bytes = [...readFileSync(qrFile)];
  await page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], "qr.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, bytes);
  await expect(dialog.getByTestId("qr-payload")).toHaveText(PAYLOAD);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Payment method saved")).toBeVisible();
  await expect(dialog).toBeHidden();

  // A second method from pasted link text (Venmo), then reorder: stored as one list, in order.
  await section.getByRole("button", { name: "Add a payment method" }).click();
  const second = page.getByRole("dialog", { name: "Add a payment method" });
  await second.getByRole("combobox", { name: "Service" }).selectOption("venmo");
  // Venmo shows Username and the profile email, off by default; Zelle's phone is gone with the kind.
  const venmoContact = second.getByTestId("payment-contact");
  await expect(venmoContact.getByRole("textbox")).toHaveCount(1);
  await expect(venmoContact.getByRole("checkbox", { name: "Show my email (alex@example.com)" })).not.toBeChecked();
  await expect(venmoContact.getByRole("checkbox", { name: /Show my phone/ })).toHaveCount(0);
  await venmoContact.getByRole("textbox", { name: "Username" }).fill("@alex-demo");
  await expect(second).toContainText("Statements show a QR code for venmo.com/u/alex-demo.");
  await second.getByRole("button", { name: "Save" }).click();
  await expect(section.getByTestId("payment-method")).toHaveCount(2);
  await section.getByRole("button", { name: "Move Venmo up" }).click();
  await page.reload();
  await expect(section.getByTestId("payment-method").first()).toContainText("Venmo");
  await section.getByRole("button", { name: "Move Venmo down" }).click();
  await expect(section.getByTestId("payment-method").first()).toContainText("Zelle (Chase)");
  await expect(section.getByTestId("payment-method").first()).toContainText("alex@example.com · 202-555-0143 · QR code · USD");
  // Stored as references to the profile (whose phone is E.164).
  expect((await (await request.get("/api/settings/profile")).json()).phone).toBe("+12025550143");
  const stored = await (await request.get("/api/settings/payment-methods")).json();
  expect(stored.methods[0]).toMatchObject({ kind: "zelle", email: null, phone: null, useProfileEmail: true, useProfilePhone: true, username: null, text: null });
  expect(stored.methods[1]).toMatchObject({ kind: "venmo", username: "@alex-demo", email: null, useProfileEmail: false });

  // The statement: "My payment details" at the end of the items, each value on its own line, with the QR drawn on a
  // light tile even in dark mode.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const sheet = page.getByRole("dialog");
  const pay = sheet.getByTestId("statement-pay");
  await expect(pay).toContainText("My payment details");
  await expect(pay).toContainText("Zelle (Chase)");
  await expect(pay.getByRole("link", { name: "alex@example.com" })).toHaveAttribute("href", "mailto:alex@example.com");
  await expect(pay.getByTestId("pay-phone")).toHaveText("202-555-0143");
  await expect(pay.getByRole("link", { name: "202-555-0143" })).toHaveAttribute("href", "tel:+12025550143");
  await expect(pay.getByTestId("pay-username")).toHaveText("@alex-demo");
  await expect(pay.getByRole("link", { name: "venmo.com/u/alex-demo" })).toHaveAttribute("href", "https://venmo.com/u/alex-demo");
  const sheetQr = pay.getByTestId("pay-qr").first();
  expect(await sheetQr.evaluate((el) => getComputedStyle(el.querySelector("rect")!).fill)).toBe("rgb(255, 255, 255)");
  await sheetQr.scrollIntoViewIfNeeded();
  expect(await scan(sheetQr)).toBe(PAYLOAD);

  // The text export lists the values and links, no QR.
  await sheet.getByRole("radio", { name: "Text" }).click();
  await expect(sheet).toContainText(
    "My payment details:\nZelle (Chase): alex@example.com  202-555-0143\nVenmo: @alex-demo  https://venmo.com/u/alex-demo",
  );
  await sheet.getByRole("radio", { name: "Items" }).click();

  // The print preview: the same block above the generated line, where yomi is a quiet wordmark.
  const href = await sheet.getByRole("link", { name: "Print preview" }).getAttribute("href");
  expect(href).toMatch(/&show=shared,notes,settlements,payment$/);
  await page.goto(href!);
  const block = page.getByTestId("print-pay");
  await expect(block.getByRole("heading", { name: "My payment details" })).toBeVisible();
  await expect(block).toContainText("Zelle QR code");
  await expect(block).not.toContainText("Scan");
  const paperQr = block.getByTestId("pay-qr").first();
  expect(await scan(paperQr)).toBe(PAYLOAD);
  expect(Math.round((await paperQr.boundingBox())!.width)).toBe(96);
  const generated = page.getByTestId("print-generated");
  await expect(generated).toHaveText(/^Generated by yomi on /);
  expect(await generated.locator("span").first().evaluate((el) => getComputedStyle(el).fontWeight)).toBe("500");
  expect((await block.boundingBox())!.y).toBeLessThan((await generated.boundingBox())!.y);
  await page.emulateMedia({ colorScheme: "dark", media: "print" });
  expect(await block.evaluate((el) => getComputedStyle(el).breakInside)).toBe("avoid");
  await page.emulateMedia({ colorScheme: "dark", media: "screen" });

  // "Payment details" off: gone from the dialog, the text and the preview, and remembered for 室友.
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const again = page.getByRole("dialog");
  const options = again.getByTestId("statement-options");
  const toggle = options.getByRole("button", { name: /^Options/ });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  const payment = options.getByRole("switch", { name: /^Payment details/ });
  await expect(payment).toHaveAttribute("aria-checked", "true");
  await payment.click();
  await expect(again.getByTestId("statement-pay")).toBeHidden();
  await again.getByRole("radio", { name: "Text" }).click();
  await expect(again).toContainText("Total: you owe me");
  await expect(again).not.toContainText("My payment details:");
  const hidden = await again.getByRole("link", { name: "Print preview" }).getAttribute("href");
  expect(hidden).toMatch(/&show=shared,notes,settlements$/);
  await page.goto(hidden!);
  await expect(page.getByRole("heading", { name: "Not settled yet" })).toBeVisible();
  await expect(page.getByTestId("print-pay")).toBeHidden();
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  await expect(page.getByRole("dialog").getByRole("switch", { name: /^Payment details/ })).toHaveAttribute("aria-checked", "false");

  // Leave the shared demo ledger as the other specs expect it, and no test images behind.
  expect((await request.put("/api/settings/payment-methods", { data: { methods: [] } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { email: null, phone: null } })).ok()).toBe(true);
  rmSync(qrFile);
  rmSync(blankFile);
});

test("profile email and phone: shared by payment methods, per-method override, statements follow a profile change", async ({ page, request }) => {
  expect((await request.put("/api/settings/payment-methods", { data: { methods: [] } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { email: null, phone: null } })).ok()).toBe(true);
  await page.goto("/settings?tab=profile");

  // Profile: Email and Phone next to "Your name", saved on Enter or blur; the phone formats as typed for its country
  // (US from the America/Chicago time zone) and saves only once it is a full number.
  const email = page.getByRole("textbox", { name: "Email", exact: true });
  const phone = page.getByRole("textbox", { name: "Phone", exact: true });
  await expect(page.getByText("Used by your payment methods. Shown on statements only through a method.")).toBeVisible();
  await email.fill("alex@example");
  await email.press("Enter");
  await expect(page.getByText("That email address does not look complete.")).toBeVisible();
  await email.fill("alex@example.com");
  await email.press("Enter");
  await expect(page.getByText("Email saved")).toBeVisible();
  await expect(page.getByTestId("profile-phone-code")).toHaveText("US +1");
  await phone.pressSequentially("202555");
  await expect(phone).toHaveValue("202-555");
  await phone.blur();
  await expect(page.getByText("That does not look like a full number in United States.")).toBeVisible();
  expect((await (await request.get("/api/settings/profile")).json()).phone).toBeNull();
  await phone.press("End");
  await phone.pressSequentially("0143");
  await expect(phone).toHaveValue("202-555-0143");
  await phone.blur();
  await expect(page.getByText("Phone saved")).toBeVisible();
  expect((await (await request.get("/api/settings/profile")).json()).phone).toBe("+12025550143");

  // Zelle: both checkboxes, ticked by default.
  const section = page.getByTestId("payment-methods");
  await section.getByRole("button", { name: "Add a payment method" }).click();
  const zelle = page.getByRole("dialog", { name: "Add a payment method" });
  await expect(zelle.getByRole("checkbox", { name: "Show my email (alex@example.com)" })).toBeChecked();
  await expect(zelle.getByRole("checkbox", { name: "Show my phone (202-555-0143)" })).toBeChecked();
  await zelle.getByRole("button", { name: "Save" }).click();
  await expect(zelle).toBeHidden();

  // PayPal: username, and only the email.
  await section.getByRole("button", { name: "Add a payment method" }).click();
  const paypal = page.getByRole("dialog", { name: "Add a payment method" });
  await paypal.getByRole("combobox", { name: "Service" }).selectOption("paypal");
  await paypal.getByRole("textbox", { name: "Username" }).fill("alexdemo");
  await expect(paypal.getByRole("checkbox", { name: /Show my phone/ })).toHaveCount(0);
  await paypal.getByRole("checkbox", { name: "Show my email (alex@example.com)" }).check();
  await paypal.getByRole("button", { name: "Save" }).click();
  await expect(paypal).toBeHidden();
  const rows = section.getByTestId("payment-method");
  await expect(rows.nth(0)).toContainText("alex@example.com · 202-555-0143 · USD");
  await expect(rows.nth(1)).toContainText("alex@example.com · alexdemo · USD");

  // Alipay and WeChat offer the phone and the email; Other both.
  await section.getByRole("button", { name: "Add a payment method" }).click();
  const kinds = page.getByRole("dialog", { name: "Add a payment method" });
  for (const kind of ["alipay", "wechat", "other"]) {
    await kinds.getByRole("combobox", { name: "Service" }).selectOption(kind);
    await expect(kinds.getByRole("checkbox", { name: /^Show my (email|phone)/ })).toHaveCount(2);
    await expect(kinds.getByRole("checkbox", { name: /^Show my (email|phone)/ }).first()).not.toBeChecked();
  }
  await kinds.getByRole("button", { name: "Cancel" }).click();

  // An override on PayPal: its own email instead of the profile's.
  await section.getByRole("button", { name: "Edit PayPal" }).click();
  const edit = page.getByRole("dialog", { name: "Edit payment method" });
  await edit.getByRole("button", { name: "Use a different email" }).click();
  await edit.getByRole("textbox", { name: "Email for this method" }).fill("alex.work@example.com");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(rows.nth(1)).toContainText("alex.work@example.com · alexdemo · USD");
  const stored = (await (await request.get("/api/settings/payment-methods")).json()).methods;
  expect(stored[0]).toMatchObject({ kind: "zelle", email: null, phone: null, useProfileEmail: true, useProfilePhone: true });
  expect(stored[1]).toMatchObject({ kind: "paypal", email: "alex.work@example.com", useProfileEmail: false, username: "alexdemo" });

  // A new profile phone: every method that uses it follows, in the list and on the statement.
  await phone.fill("202 555 0199");
  await phone.press("Enter");
  await expect(rows.nth(0)).toContainText("alex@example.com · 202-555-0199 · USD");
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  const sheet = page.getByRole("dialog");
  const pay = sheet.getByTestId("statement-pay");
  await expect(pay.getByTestId("pay-phone")).toHaveText("202-555-0199");
  await expect(pay.getByTestId("pay-email")).toHaveText(["alex@example.com", "alex.work@example.com"]);
  await sheet.getByRole("radio", { name: "Text" }).click();
  await expect(sheet).toContainText("My payment details:\nZelle: alex@example.com  202-555-0199\nPayPal: alex.work@example.com  alexdemo  https://paypal.me/alexdemo/");

  // No profile email: the checkbox becomes "Add your email in Profile", edited inline and saved to the profile.
  expect((await request.put("/api/settings/profile", { data: { email: null } })).ok()).toBe(true);
  await page.goto("/settings?tab=profile");
  await section.getByRole("button", { name: "Add a payment method" }).click();
  const venmo = page.getByRole("dialog", { name: "Add a payment method" });
  await venmo.getByRole("combobox", { name: "Service" }).selectOption("venmo");
  await expect(venmo.getByRole("checkbox", { name: /Show my email/ })).toHaveCount(0);
  await venmo.getByRole("button", { name: "Add your email in Profile" }).click();
  const inline = venmo.getByRole("textbox", { name: "Your email" });
  await expect(inline).toBeFocused();
  await inline.fill("alex@example.com");
  await inline.press("Enter");
  await expect(venmo.getByRole("checkbox", { name: "Show my email (alex@example.com)" })).toBeChecked();
  await expect(venmo).toBeVisible();
  await venmo.getByRole("button", { name: "Cancel" }).click();
  await expect(email).toHaveValue("alex@example.com");
  expect((await (await request.get("/api/settings/profile")).json()).email).toBe("alex@example.com");

  expect((await request.put("/api/settings/payment-methods", { data: { methods: [] } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { email: null, phone: null } })).ok()).toBe(true);
});

test("phone numbers: country picker, per-country display on statements, a pasted + number switches the country", async ({ page, request }) => {
  // Fictional numbers only: US 202-555-0143, China 138 0013 8000 (a documented example).
  expect((await request.put("/api/settings/profile", { data: { email: null, phone: null } })).ok()).toBe(true);
  expect(
    (await request.put("/api/settings/payment-methods", { data: { methods: [{ kind: "zelle", label: "Zelle (Chase)", useProfilePhone: true, currencies: ["USD"] }] } })).ok(),
  ).toBe(true);
  await page.goto("/settings?tab=profile");
  const phone = page.getByRole("textbox", { name: "Phone", exact: true });
  const country = page.getByRole("combobox", { name: "Country or region" });
  // United States and China first, then every other country by name (the full list renders once hydrated).
  await expect(country.locator("option")).toHaveCount(245);
  expect(await country.locator("option").evaluateAll((os) => os.slice(0, 3).map((o) => o.textContent))).toEqual([
    "United States +1",
    "China +86",
    "Afghanistan +93",
  ]);

  // China: the example formats as typed and shows international on the statement.
  await country.selectOption("CN");
  await expect(page.getByTestId("profile-phone-code")).toHaveText("CN +86");
  await phone.pressSequentially("13800138000");
  await expect(phone).toHaveValue("138 0013 8000");
  await phone.press("Enter");
  await expect(page.getByText("Phone saved")).toBeVisible();
  expect((await (await request.get("/api/settings/profile")).json()).phone).toBe("+8613800138000");
  await expect(page.getByTestId("payment-method").first()).toContainText("+86 138 0013 8000 · USD");
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  let pay = page.getByRole("dialog").getByTestId("statement-pay");
  await expect(pay.getByTestId("pay-phone")).toHaveText("+86 138 0013 8000");
  await expect(pay.getByRole("link", { name: "+86 138 0013 8000" })).toHaveAttribute("href", "tel:+8613800138000");

  // Back to the United States: national style on a USD statement.
  await page.goto("/settings?tab=profile");
  await expect(page.getByTestId("profile-phone-code")).toHaveText("CN +86");
  await expect(phone).toHaveValue("138 0013 8000");
  await country.selectOption("US");
  await expect(page.getByTestId("profile-phone-code")).toHaveText("US +1");
  await phone.fill("2025550143");
  await expect(phone).toHaveValue("202-555-0143");
  await phone.press("Enter");
  await expect(page.getByText("Phone saved")).toBeVisible();
  await page.goto("/split");
  await roommateUsd(page).getByRole("button", { name: "Statement" }).click();
  pay = page.getByRole("dialog").getByTestId("statement-pay");
  await expect(pay.getByTestId("pay-phone")).toHaveText("202-555-0143");

  // "Use a different number": Save waits for a full number; pasting "+86 …" picks China.
  await page.goto("/settings?tab=profile");
  await page.getByTestId("payment-methods").getByRole("button", { name: "Edit Zelle (Chase)" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit payment method" });
  await dialog.getByRole("button", { name: "Use a different number" }).click();
  const own = dialog.getByRole("textbox", { name: "Phone for this method" });
  await own.pressSequentially("202");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await own.fill("");
  await own.focus();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "+86 138 0013 8000");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(own).toHaveValue("138 0013 8000");
  await expect(dialog.getByTestId("payment-own-phone-input-code")).toHaveText("CN +86");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  expect((await (await request.get("/api/settings/payment-methods")).json()).methods[0]).toMatchObject({ phone: "+8613800138000", useProfilePhone: false });

  expect((await request.put("/api/settings/payment-methods", { data: { methods: [] } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { email: null, phone: null } })).ok()).toBe(true);
});
