import { readFileSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, pinClock, test } from "./fixtures";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { qrCardOriginal } from "./qr-card";

/** Fictional payment details; the Zelle QR payload is a made-up link on example.com. */
const ZELLE_QR = "https://example.com/pay/zelle/alex-demo?ref=e2e-export";
const ORIGINAL_QR = "https://example.com/pay/zelle/alex-demo?ref=e2e-export-original";
const METHODS = [
  { kind: "zelle", label: "Zelle (Chase)", email: "alex@example.com", phone: "+1 555 010 0100", qr: ZELLE_QR },
  { kind: "venmo", username: "@alex-demo", email: "alex@example.com" },
];
const ALL_OPTIONS = "shared,names,myshare,notes,settlements,category,payment";

async function roommateId(page: Page): Promise<number> {
  const { balances } = (await (await page.request.get("/api/split/balances")).json()) as { balances: { participantId: number; name: string; currency: string }[] };
  return balances.find((b) => b.name === "室友" && b.currency === "USD")!.participantId;
}

test.beforeEach(async ({ request }) => {
  expect((await request.put("/api/settings/payment-methods", { data: { methods: METHODS } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { displayName: "Alexandra Whitfield" } })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  // Leave the shared demo ledger as the other specs expect it.
  expect((await request.put("/api/settings/payment-methods", { data: { methods: [] } })).ok()).toBe(true);
  expect((await request.put("/api/settings/profile", { data: { displayName: null } })).ok()).toBe(true);
});

test("statement on paper: the Total never starts a page alone, the header never ends one, payment details stay with the generated line", async ({
  page,
}) => {
  const id = await roommateId(page);
  await page.goto(`/split/statement/print?participantId=${id}&currency=USD&locale=en&show=${ALL_OPTIONS}`);
  await expect(page.locator("[data-print-paper]")).toBeVisible();
  await page.emulateMedia({ media: "print" });

  // The paper structure: the section title and column header repeat, the tfoot closes the card on every page, and
  // the last three items travel with the Total in one unbreakable group.
  const open = page.locator(".print-table").first();
  expect(await open.locator("thead").evaluate((el) => getComputedStyle(el).display)).toBe("table-header-group");
  expect(await open.locator(".print-head-title").evaluate((el) => getComputedStyle(el).display)).toBe("table-row");
  expect(await open.locator("tfoot").evaluate((el) => getComputedStyle(el).display)).toBe("table-footer-group");
  const tail = open.locator(".print-tail");
  expect(await tail.evaluate((el) => getComputedStyle(el).breakInside)).toBe("avoid");
  await expect(tail.locator(".print-item")).toHaveCount(3);
  await expect(tail.locator(".print-total")).toHaveCount(1);
  // On paper the section card is drawn by the table, so a page fragment ends at its last row.
  expect(await page.locator(".print-card").first().evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");

  // Measure the real fragmentation: the paper becomes a multicol of fixed-height "pages" (the same fragmentation engine
  // as printing), and a spacer pushes the sections down 10px at a time across every row boundary.
  const report = await page.evaluate(() => {
    const paper = document.querySelector<HTMLElement>("[data-print-paper]")!;
    const spacer = document.createElement("div");
    paper.querySelector("header")!.after(spacer);
    paper.style.cssText = "column-count: 1; column-fill: auto; column-gap: 40px; height: 900px;";
    const width = paper.getBoundingClientRect().width + 40;
    const col = (el: Element) => Math.floor((el.getBoundingClientRect().left - paper.getBoundingClientRect().left) / width);
    const table = paper.querySelector(".print-table")!;
    const items = [...table.querySelectorAll(".print-item")];
    const out: { h: number; withTotal: number; withHeader: number; paySplit: boolean }[] = [];
    for (let h = 0; h <= 600; h += 10) {
      spacer.style.height = `${h}px`;
      const totalCol = col(table.querySelector(".print-total")!);
      const headCol = col(table.querySelector("thead tr:not(.print-head-title)")!);
      out.push({
        h,
        withTotal: items.filter((r) => col(r) === totalCol).length,
        withHeader: items.filter((r) => col(r) === headCol).length,
        paySplit: col(paper.querySelector("[data-testid=print-pay]")!) !== col(paper.querySelector("[data-testid=print-generated]")!),
      });
    }
    return out;
  });
  for (const r of report) {
    expect(r.withTotal, `spacer ${r.h}px: item rows on the Total's page`).toBeGreaterThanOrEqual(3);
    expect(r.withHeader, `spacer ${r.h}px: item rows under the header`).toBeGreaterThanOrEqual(1);
    expect(r.paySplit, `spacer ${r.h}px: payment details and generated line apart`).toBe(false);
  }
});

test("Save as image: one long PNG at 2x with a 32px margin, QR codes readable (the original QR card too), in both themes and on white paper", async ({
  browser,
  page,
  request,
}, testInfo) => {
  const id = await roommateId(page);
  // A third method shows the user's own QR card image ("Original"), a fictional card made at test time.
  await page.goto("/settings");
  const original = await qrCardOriginal(page, ORIGINAL_QR);
  const withOriginal = [...METHODS, { kind: "zelle", label: "Zelle card", qr: ORIGINAL_QR, original, display: "original" }];
  expect((await request.put("/api/settings/payment-methods", { data: { methods: withOriginal } })).ok()).toBe(true);
  const cases = [
    { scheme: "dark" as const, colors: "", locale: "en", button: "Save as image", toast: "Image saved" },
    { scheme: "light" as const, colors: "", locale: "zh-CN", button: "保存为图片", toast: "图片已保存" },
    { scheme: "dark" as const, colors: "&colors=light", locale: "en", button: "Save as image", toast: "Image saved" },
  ];
  for (const c of cases) {
    const ctx = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      timezoneId: testInfo.project.use.timezoneId,
      colorScheme: c.scheme,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await pinClock(ctx);
    const p = await ctx.newPage();
    await p.goto(`/split/statement/print?participantId=${id}&currency=USD&locale=${c.locale}&show=${ALL_OPTIONS}${c.colors}`);
    const paper = p.locator("[data-print-paper]");
    await expect(paper).toBeVisible();
    const toolbar = p.getByRole("toolbar");
    // Save as PDF stays the primary action; the image buttons sit beside Print.
    await expect(toolbar.getByRole("button", { name: c.button })).toBeVisible();
    const [download] = await Promise.all([p.waitForEvent("download"), toolbar.getByRole("button", { name: c.button }).click()]);
    await expect(p.getByText(c.toast)).toBeVisible();
    // CJK names stay in the file name.
    expect(download.suggestedFilename()).toMatch(/^yomi-statement-室友-USD-\d{4}-\d{2}-\d{2}\.png$/);
    const file = testInfo.outputPath(`statement-${c.scheme}${c.colors ? "-white" : ""}.png`);
    await download.saveAs(file);
    const png = PNG.sync.read(readFileSync(file));
    const box = (await paper.boundingBox())!;
    expect(box.width).toBe(960);
    expect(png.width).toBe(2 * (960 + 64));
    expect(Math.abs(png.height - 2 * (box.height + 64))).toBeLessThanOrEqual(2);
    // The margin is the paper color; the image starts with it.
    const bg = await paper.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(`rgb(${png.data[0]}, ${png.data[1]}, ${png.data[2]})`).toBe(bg);
    // Every QR code decodes from the image at its place on the paper.
    const qrs = await p.getByTestId("pay-qr").evaluateAll((els) => els.map((el) => ({ box: el.getBoundingClientRect().toJSON() as DOMRect, value: el.getAttribute("data-qr") })));
    expect(qrs.length).toBe(3);
    await expect(p.getByTestId("pay-qr").last()).toHaveAttribute("src", original.dataUrl);
    for (const { box: q, value } of qrs) {
      const x0 = Math.round((q.x - box.x + 32 - 8) * 2);
      const y0 = Math.round((q.y - box.y + 32 - 8) * 2);
      const w = Math.round((q.width + 16) * 2);
      const h = Math.round((q.height + 16) * 2);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) data.set(png.data.subarray(((y0 + y) * png.width + x0) * 4, ((y0 + y) * png.width + x0 + w) * 4), y * w * 4);
      expect(jsQR(data, w, h)?.data).toBe(value);
    }
    rmSync(file);
    if (c.locale === "en" && !c.colors) {
      // "Copy image" puts the same PNG on the clipboard (shown where the browser can do that).
      await toolbar.getByRole("button", { name: "Copy image" }).click();
      await expect(p.getByText("Image copied")).toBeVisible();
      const copied = await p.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        const bitmap = await createImageBitmap(await item!.getType("image/png"));
        return [bitmap.width, bitmap.height];
      });
      expect(copied).toEqual([png.width, png.height]);
    }
    await ctx.close();
  }
});
