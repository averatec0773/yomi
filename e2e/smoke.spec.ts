import type { Locator, Page } from "@playwright/test";
import { expect, openRowPopover, pinClock, test } from "./fixtures";

/** "$1,234.56" → 123456 (minor units), from the element's text. */
async function minorOf(el: Locator): Promise<number> {
  const text = (await el.innerText()).replace(/[^\d.]/g, "");
  return Math.round(Number(text) * 100);
}

function roommateUsd(page: Page): Locator {
  return page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Settle up with 室友 in USD" }) });
}

/** A plain expense row (ghost "Split" button, no split yet) and a stable locator for it by id. */
async function plainRow(page: Page, nth = 0): Promise<Locator> {
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Split", exact: true }) }).nth(nth);
  const id = await row.getAttribute("data-tx-id");
  return page.locator(`[role=row][data-tx-id="${id}"]`);
}

test("transactions: split popover splits a row with 室友 and it sticks", async ({ page }) => {
  await page.goto("/transactions?month=2026-09");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("navigation", { name: "Period" })).toContainText("September 2026");
  await expect(page.getByRole("region", { name: "Your share, September" })).toContainText("$");
  const target = await plainRow(page);
  const id = await target.getAttribute("data-tx-id");
  const dialog = await openRowPopover(page, target, target.getByRole("button", { name: "Split", exact: true }));
  await expect(dialog).toContainText("Split ·");
  await expect(dialog.getByRole("checkbox", { name: "Me" })).toBeDisabled();
  const saved = page.waitForResponse((r) => r.url().includes(`/api/transactions/${id}/`) && r.request().method() === "POST");
  await dialog.getByRole("checkbox", { name: "室友" }).check();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).toContainText(/Paid by you · \S+( \/ \S+)? each/);
  // This transaction's share only, never a running balance.
  await expect(dialog).toContainText(/室友's share of this one: \S+/);
  await expect(dialog).not.toContainText(/owe/i);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Split .+ with 室友$/)).toBeVisible();
  await expect(target.getByRole("button", { name: /^Split with 室友/ })).toHaveText("Split · 2");
  await expect(target).toContainText(/you\s*[$¥]\d/);
  await page.reload();
  await expect(target.getByRole("button", { name: /^Split with 室友/ })).toHaveText("Split · 2");
});

test("transactions: keyboard a opens split, 1 toggles, Esc closes, Undo puts it back", async ({ page }) => {
  await page.goto("/transactions?month=2026-09");
  const target = await plainRow(page);
  await target.click({ position: { x: 240, y: 8 } });
  await page.keyboard.press("a");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const first = dialog.getByRole("checkbox").nth(1);
  await page.keyboard.press("1");
  await expect(first).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(target.getByRole("button", { name: /^Split with / })).toHaveText("Split · 2");

  // One outcome toast per popover, with Undo back to the state before it opened.
  const undone = page.waitForResponse((r) => r.url().includes(`/split`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Undo" }).click();
  expect((await undone).ok()).toBe(true);
  await expect(page.getByText("Undone")).toBeVisible();
  await expect(target.getByRole("button", { name: "Split", exact: true })).toBeAttached();
  await page.reload();
  await expect(target.getByRole("button", { name: "Split", exact: true })).toBeAttached();
});

test("quick-add: lunch 35 @室友 saves and the row appears split", async ({ page }) => {
  await page.goto("/transactions?month=2026-09");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Add", exact: true });
  await input.fill("lunch 35 @室友");
  await input.press("Enter");
  await expect(page.getByText(/^Added [¥$]/)).toBeVisible();
  await page.keyboard.press("Escape");
  const row = page.getByRole("row").filter({ hasText: "lunch" }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /^Split with 室友/ })).toHaveText("Split · 2");
});

test("quick-add: a pasted ICBC alert saves once as an Auto row with no Chinese in English", async ({ page }) => {
  const sms = "您尾号3141信用卡9月27日08:24POS支出(消费BUSY BEE BOBA Houston)15.74美元。【工商银行】";
  await page.goto("/transactions");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Add", exact: true });
  await input.fill(sms);
  // 08:24 Beijing on the 27th is 19:24 on the 26th in Chicago (the zone the browser reports, see playwright.config.ts).
  await expect(page.getByTestId("quick-sms")).toContainText(/ICBC card ····3141 · Sep 26 19:24 · BUSY BEE BOBA · \$15\.74/);
  await input.press("Enter");
  await expect(page.getByText("Added $15.74 from the ICBC alert")).toBeVisible();
  await input.fill(sms);
  await expect(page.getByTestId("quick-sms")).toBeVisible();
  await input.press("Enter");
  await expect(page.getByText("This alert is already in the ledger")).toBeVisible();
  await page.keyboard.press("Escape");
  const row = page.getByRole("row").filter({ hasText: "Busy Bee Boba" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("from SMS");
  await expect(row).not.toContainText("消费");
  await row.hover();
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Source details" }).click();
  const details = page.getByRole("dialog");
  await expect(details).toContainText("2026-09-26 19:24");
  await expect(details.getByTestId("tx-booked-beijing")).toHaveText("Booked Sep 27 Beijing time");
});

test("time zone: settings shows the zone and regroups days when it changes", async ({ page }) => {
  await page.goto("/settings");
  const picker = page.getByTestId("time-zone-picker");
  await expect(picker).toHaveText("America/Chicago");
  await expect(page.getByText("Dates group by this zone.")).toBeVisible();
  await picker.click();
  await page.getByPlaceholder("Search time zones").fill("Shanghai");
  await page.getByRole("option", { name: "Asia/Shanghai" }).click();
  await expect(page.getByText(/Time zone set to Asia\/Shanghai/)).toBeVisible();
  await expect(picker).toHaveText("Asia/Shanghai");
  // Back to Chicago so the rest of the run sees the same days.
  await picker.click();
  await page.getByPlaceholder("Search time zones").fill("Chicago");
  await page.getByRole("option", { name: "America/Chicago" }).click();
  await expect(picker).toHaveText("America/Chicago");
});

test("bulk: split three rows with 室友, then remove it", async ({ page }) => {
  await page.goto("/transactions?month=2026-09");
  const rows = [await plainRow(page, 0), await plainRow(page, 1), await plainRow(page, 2)];
  for (const r of rows) {
    await r.hover();
    await r.getByRole("checkbox", { name: "Select" }).click();
  }
  const bar = page.getByRole("toolbar", { name: "Bulk actions" });
  await expect(bar).toContainText("3 selected");
  await bar.getByRole("button", { name: "Split…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Split · 3 selected");
  await dialog.getByRole("checkbox", { name: "室友" }).check();
  await dialog.getByRole("button", { name: "Apply to 3" }).click();
  await expect(page.getByText("Split 3 transactions with 室友")).toBeVisible();
  for (const r of rows) await expect(r.getByRole("button", { name: /^Split with 室友/ })).toHaveText("Split · 2");

  await bar.getByRole("button", { name: "Split…" }).click();
  await dialog.getByRole("button", { name: "Remove the split from these" }).click();
  await expect(page.getByText("Removed the split from 3 transactions")).toBeVisible();
  for (const r of rows) await expect(r.getByRole("button", { name: "Split", exact: true })).toBeAttached();
});

test("split: opening balance moves 室友's number", async ({ page }) => {
  await page.goto("/split");
  const line = roommateUsd(page);
  await expect(line).toContainText("To settle with 室友");
  await expect(page.locator("main")).not.toContainText(/\bowes?\b/i);
  const hero = line.locator(".text-hero");
  const before = await minorOf(hero);
  expect(before).toBeGreaterThan(0);

  await page.getByRole("button", { name: "More actions for 室友" }).click();
  await page.getByRole("menuitem", { name: "Set opening balance" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Currency" }).selectOption("USD");
  await dialog.getByRole("textbox", { name: "Opening amount" }).fill("10");
  await dialog.getByRole("button", { name: "Record opening balance" }).click();
  await expect(page.getByText("Opening balance recorded: to settle with 室友 $10.00")).toBeVisible();

  await expect.poll(() => minorOf(hero)).toBe(before + 1000);
  await expect(page.getByText("Opening: to settle with 室友").first()).toBeVisible();
});

test("analysis: the ?month= alias opens that month with a total", async ({ page }) => {
  await page.goto("/analysis?month=2026-09");
  await expect(page.getByRole("navigation", { name: "Period" })).toContainText("September 2026");
  await expect(page.getByRole("navigation", { name: "Main navigation" }).locator("[aria-current=page]")).toHaveText("Analysis");
  const section = page.getByRole("region", { name: "USD stats" });
  await expect(section).toContainText("USD spending");
  expect(await minorOf(section.locator(".text-hero"))).toBeGreaterThan(0);
});

test("analysis: preset in the URL, custom range with monthly trend, category opens the same range", async ({ page }) => {
  await page.goto("/analysis");
  const bar = page.getByRole("navigation", { name: "Period" });
  await bar.getByRole("button", { name: /^Choose a period/ }).click();
  await page.getByRole("menuitem", { name: "Last 3 months" }).click();
  await expect(page).toHaveURL(/preset=last_3_months/);
  await bar.getByRole("button", { name: /^Choose a period/ }).click();
  await expect(page.getByRole("menuitem", { name: "Last 3 months" })).toHaveAttribute("aria-current", "page");

  // Previous steps by the range's own unit: three months back.
  await page.keyboard.press("Escape");
  await bar.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}/);

  await bar.getByRole("button", { name: /^Choose a period/ }).click();
  await page.getByRole("menuitem", { name: "Custom range" }).click();
  const form = page.getByRole("form", { name: "Custom range" });
  await form.getByLabel("Start date").fill("2026-07-01");
  await form.getByLabel("End date").fill("2026-09-30");
  await form.getByRole("button", { name: "View" }).click();
  await expect(page).toHaveURL(/from=2026-07-01&to=2026-09-30/);
  await expect(page.getByRole("heading", { name: "Analysis" })).toBeVisible();
  await expect(page.getByText("Jul – Sep 2026").first()).toBeVisible();

  const cny = page.getByRole("region", { name: "CNY stats" });
  expect(await minorOf(cny.locator(".text-hero"))).toBeGreaterThan(0);
  await expect(cny.getByRole("heading", { name: /Monthly spending/ })).toBeVisible();
  await expect(cny.getByRole("table")).toContainText("Jul 2026");
  await expect(cny.getByRole("table")).toContainText("Sep 2026");

  await cny.getByRole("link").filter({ hasText: "%" }).first().click();
  await expect(page).toHaveURL(/\/transactions\?from=2026-07-01&to=2026-09-30&(categoryId=\d+|uncategorized=1)/);
  await expect(page.getByText("Jul – Sep 2026", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").first()).toBeVisible();

  // Invalid custom range: the message comes from core's error code, no crash.
  await page.goto("/analysis?from=2026-09-30&to=2026-07-01");
  await expect(page.getByRole("form", { name: "Custom range" }).getByRole("alert")).toContainText("The start date cannot be after the end date.");
});

test("nav: sidebar Tools group, sub-items light up, group and rail remember their state, crumb leads back, phones get tabs", async ({ page }) => {
  await page.goto("/transactions");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const main = page.getByRole("main");
  await expect(nav.getByRole("link")).toHaveText(["Transactions", "Analysis", "Assets", "Tools", "Split and settle", "Import", "Rules"]);
  await nav.getByRole("link", { name: "Tools", exact: true }).click();
  await expect(page).toHaveURL(/\/tools$/);
  await expect(nav.locator("[aria-current=page]")).toHaveText("Tools");
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Split", "Data", "Maintenance"]);
  await main.getByRole("link", { name: /Import statements/ }).click();
  await expect(page.getByRole("heading", { name: "Import", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Import history" })).toBeVisible();
  await expect(nav.locator("[aria-current=page]")).toHaveText("Import");
  await page.getByRole("navigation", { name: "Location" }).getByRole("link", { name: "Tools", exact: true }).click();
  await expect(page).toHaveURL(/\/tools$/);

  // Split is a Tools sub-item: the hub row and the sidebar both lead there, the sub-item lights up.
  await main.getByRole("link", { name: /Split and settle/ }).click();
  await expect(page.getByRole("heading", { name: "Split and settle" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Location" })).toContainText("Tools");
  await expect(nav.locator("[aria-current=page]")).toHaveText("Split and settle");
  await nav.getByRole("link", { name: "Rules" }).click();
  await expect(page).toHaveURL(/\/tools\/rules$/);
  await expect(nav.locator("[aria-current=page]")).toHaveText("Rules");

  // The Tools group closes and stays closed after a reload; \ o still opens the hub.
  await nav.getByRole("button", { name: "Hide tools" }).click();
  await expect(nav.getByRole("link", { name: "Rules" })).toBeHidden();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-tools", "closed");
  await expect(nav.getByRole("link", { name: "Rules" })).toBeHidden();
  await page.keyboard.press("\\");
  await page.keyboard.press("o");
  await expect(page).toHaveURL(/\/tools$/);

  // Collapse to the icon rail (sub-items show as icons even with the group closed); the state survives a reload.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(nav.getByRole("link", { name: "Rules" })).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-sidebar", "collapsed");
  await nav.getByRole("button", { name: "Show tools" }).click();
  await expect(nav.getByRole("link", { name: "Rules" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-tools", "closed");

  // Phone: bottom tabs and the floating Add; Settings and Shortcuts under Tools.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools");
  const tabs = page.getByRole("navigation", { name: "Main navigation" });
  await expect(tabs.getByRole("link")).toHaveText(["Transactions", "Analysis", "Assets", "Tools"]);
  await expect(page.getByRole("button", { name: "Add a transaction" })).toBeVisible();
  await page.getByRole("button", { name: /Keyboard shortcuts/ }).click();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: /^Settings/ }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test("tools: maintenance rows deep-link to settings tabs and anchors, which flash on arrival; the banks row opens Settings > Connections", async ({ page }) => {
  await page.goto("/tools");
  const main = page.getByRole("main");
  await main.getByRole("link", { name: /^Backup/ }).click();
  await expect(page).toHaveURL(/\/settings\?tab=data#backup$/);
  await expect(page.getByRole("tab", { name: "Data" })).toHaveAttribute("aria-selected", "true");
  const backup = page.locator("#backup");
  await expect(backup).toHaveAttribute("data-flash", "");
  await expect(backup).toBeInViewport();
  await expect(backup).not.toHaveAttribute("data-flash");

  await page.goto("/tools");
  await main.getByRole("link", { name: /^Time zone/ }).click();
  await expect(page).toHaveURL(/\/settings\?tab=general#time-zone$/);
  await expect(page.locator("#time-zone")).toHaveAttribute("data-flash", "");

  // A legacy hash link opens the tab that holds the anchor, then flashes it; the URL gains the tab.
  await page.goto("/settings#backup");
  await expect(page.getByRole("tab", { name: "Data" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/settings\?tab=data#backup$/);
  await expect(page.locator("#backup")).toHaveAttribute("data-flash", "");
  await expect(page.locator("#backup")).toBeInViewport();
  await expect(page.locator("#general")).toBeHidden();

  await page.goto("/tools");
  await main.getByRole("link", { name: /^Bank and brokerage connections/ }).click();
  await expect(page).toHaveURL(/\/settings\?tab=connections$/);
  await expect(page.getByTestId("settings-connections")).toBeInViewport();
});

test("transfer: 室友 pays back $10 from the tools hub, balance drops", async ({ page }) => {
  await page.goto("/split");
  const hero = roommateUsd(page).locator(".text-hero");
  const before = await minorOf(hero);

  await page.goto("/tools");
  await page.getByRole("button", { name: /Record a transfer or repayment/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "They sent me" }).click();
  await dialog.getByRole("combobox", { name: "Who" }).selectOption({ label: "室友" });
  await dialog.getByRole("combobox", { name: "Currency", exact: true }).selectOption("USD");
  await dialog.getByRole("textbox", { name: "Amount", exact: true }).fill("10");
  await dialog.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText("Recorded: 室友 sent you $10.00")).toBeVisible();

  await page.goto("/split");
  await expect.poll(() => minorOf(hero)).toBe(before - 1000);
});

test("auto-split: enable from the split popover, split the existing rows, /split count drops", async ({ page }) => {
  const month = page.getByRole("link", { name: /^2026-09: \d+ unsplit$/ });
  const countOf = async () => Number((await month.getAttribute("aria-label"))!.match(/(\d+) unsplit/)![1]);

  await page.goto("/split");
  const before = await countOf();
  await month.click();
  await expect(page).toHaveURL(/month=2026-09&unsplit=1/);
  await expect(page.getByRole("button", { name: "Not split" })).toHaveAttribute("aria-pressed", "true");

  // First merchant with at least two unsplit rows this month.
  const rows = page.getByRole("row");
  const merchants = await rows.evaluateAll((els) => els.map((e) => (e.querySelector(".font-medium") as HTMLElement | null)?.innerText ?? ""));
  const merchant = merchants.find((m, i) => m && merchants.indexOf(m) === i && merchants.filter((x) => x === m).length >= 2)!;
  expect(merchant).toBeTruthy();
  const n = merchants.filter((m) => m === merchant).length;

  const row = rows.filter({ hasText: merchant }).first();
  const dialog = await openRowPopover(page, row, row.getByRole("button", { name: /^Split/ }).first());
  await dialog.getByRole("checkbox", { name: "室友" }).check();
  const auto = dialog.getByRole("checkbox", { name: `Split ${merchant} like this from now on` });
  await expect(auto).toBeEnabled();
  await auto.check();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^Also split the (\d+ existing ones|existing one)$/ }).click();
  await expect(page.getByText(new RegExp(`^Split \\d+ transactions? from ${merchant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} equally$`))).toBeVisible();
  // Split rows stay in place, marked, until the next navigation.
  await expect(rows.filter({ hasText: merchant }).filter({ hasText: "Split done" })).toHaveCount(n);

  await page.goto("/split");
  expect(await countOf()).toBeLessThanOrEqual(before - n);
});

test("counterparties: claim Momo as a new participant, its transfer becomes a repayment candidate", async ({ page }) => {
  await page.goto("/split");
  const section = page.getByRole("list", { name: "Who sends you money" });
  const momo = section.getByRole("listitem", { name: "Momo" }).filter({ hasText: "WeChat" });
  await expect(momo).toContainText("1 in ¥250.00 · 1 out ¥500.00");
  await momo.getByRole("button", { name: "New person" }).click();
  await momo.getByRole("textbox", { name: "Name for Momo" }).fill("莫莫");
  await momo.getByRole("button", { name: "Create and link" }).click();
  await expect(page.getByText("Momo (WeChat) is now 莫莫")).toBeVisible();

  // The Alipay "Momo" now defaults to 莫莫, and the WeChat transfer waits under Possible repayments.
  await expect(section.getByRole("listitem", { name: "Momo" })).toHaveCount(1);
  await expect(section.getByRole("combobox", { name: "Who is Momo" }).locator("option:checked")).toHaveText("莫莫");
  const more = page.getByRole("button", { name: /^\d+ more$/ }).first(); // Possible repayments comes first
  if (await more.isVisible()) await more.click();
  await expect(page.getByRole("button", { name: "莫莫 paid back" }).first()).toBeVisible();

  await page.locator("summary", { hasText: "People" }).click();
  await expect(page.getByRole("list", { name: "莫莫's identities" })).toContainText("Momo");
});

test("language: switching to 中文 in settings shows Chinese nav labels and stays after a reload", async ({ page }) => {
  await page.goto("/transactions?month=2026-09");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link")).toHaveText(["Transactions", "Analysis", "Assets", "Tools", "Split and settle", "Import", "Rules"]);
  await expect(page.getByRole("group", { name: "Language" })).toHaveCount(0);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  const tablist = page.getByRole("tablist", { name: "Settings sections" });
  await expect(tablist.getByRole("tab")).toHaveText(["General", "Profile", "Appearance", "Shortcuts", "Connections", "Security", "Data"]);
  const headings = ["General", "Profile", "Appearance", "Keyboard shortcuts", "Connections", "Security", "Data"];
  for (const [i, heading] of headings.entries()) {
    await tablist.getByRole("tab").nth(i).click();
    await expect(page.getByRole("tabpanel").getByRole("heading", { level: 2 })).toHaveText(heading);
  }
  await expect(page.getByTestId("settings-connections")).toBeHidden();
  await tablist.getByRole("tab", { name: "Connections" }).click();
  await expect(page.getByTestId("settings-connections")).toContainText("Not set up");
  await tablist.getByRole("tab", { name: "General" }).click();
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "中文" }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const zhTabs = page.getByRole("tablist", { name: "设置分区" }).getByRole("tab");
  await expect(zhTabs).toHaveText(["通用", "个人资料", "外观", "快捷键", "连接", "安全", "数据"]);
  await zhTabs.nth(3).click();
  await expect(page.getByRole("tabpanel").getByRole("heading", { level: 2 })).toHaveText("键盘快捷键");
  const zhNav = page.getByRole("navigation", { name: "主导航" });
  await zhNav.getByRole("link", { name: "交易" }).click();
  await expect(zhNav.getByRole("link")).toHaveText(["交易", "分析", "资产", "工具", "分摊与结算", "导入", "规则"]);
  await expect(page.getByText(/2026年\d+月/).first()).toBeVisible();
  await page.reload();
  await expect(zhNav.getByRole("link")).toHaveText(["交易", "分析", "资产", "工具", "分摊与结算", "导入", "规则"]);

  // ? lists every shortcut; \ , opens settings from the keyboard.
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "键盘快捷键" });
  await expect(sheet).toContainText("跳转");
  await expect(sheet).toContainText("设置");
  await expect(sheet).toContainText("先按 \\，再按字母");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.keyboard.press("\\");
  await page.keyboard.press(",");
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("group", { name: "语言" }).getByRole("button", { name: "EN" }).click();
  await expect(nav.getByRole("link")).toHaveText(["Transactions", "Analysis", "Assets", "Tools", "Split and settle", "Import", "Rules"]);
});

test("settings tabs: server-rendered ?tab=, arrows and back/forward switch tabs, phones scroll the bar only", async ({ page, browser, baseURL }) => {
  // Without the app's scripts (no hydration; only the inline streaming ones run) the server already shows the tab.
  const noApp = await browser.newContext({ baseURL });
  await pinClock(noApp);
  const raw = await noApp.newPage();
  await raw.route(/\/_next\/static\/.*\.js/, (route) => route.abort());
  await raw.goto("/settings?tab=shortcuts");
  await expect(raw.locator("#shortcuts")).toBeVisible();
  await expect(raw.locator("#shortcuts").getByRole("heading", { level: 2 })).toHaveText("Keyboard shortcuts");
  await expect(raw.locator("#general")).toBeHidden();
  await expect(raw.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
  await noApp.close();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  const tab = (name: string) => page.getByRole("tab", { name });
  await expect(tab("General")).toHaveAttribute("aria-selected", "true");
  await expect(tab("General")).toHaveAttribute("aria-controls", "general");
  await tab("Profile").click();
  await expect(page).toHaveURL(/\/settings\?tab=profile$/);
  await expect(page.getByRole("textbox", { name: "Your name" })).toBeVisible();
  await tab("Data").click();
  await expect(page).toHaveURL(/\/settings\?tab=data$/);
  await expect(page.locator("#backup")).toBeVisible();

  // Back and forward walk the tabs.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\?tab=profile$/);
  await expect(tab("Profile")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#data")).toBeHidden();
  await page.goBack();
  await expect(tab("General")).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(tab("Profile")).toHaveAttribute("aria-selected", "true");

  // Roving tabindex: only the active tab is in the tab order; arrows move and open.
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await tab("Profile").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab("Appearance")).toBeFocused();
  await expect(tab("Appearance")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(tab("General")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab("Data")).toBeFocused();
  await expect(page).toHaveURL(/\/settings\?tab=data$/);

  // Desktop: the bar stays under the top edge while a long panel scrolls.
  await tab("Shortcuts").click();
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => Math.round((await page.getByRole("tablist").boundingBox())!.y)).toBeLessThanOrEqual(8);

  // Phones: the bar scrolls sideways, the page never does; the active tab is in view; 44px hit areas.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings?tab=data");
  await expect(tab("Data")).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.getByRole("tablist").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect((await tab("General").boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("theme: Light and Dark apply at once, survive a reload, System clears the attribute", async ({ page, request }) => {
  // The OS says dark, so a forced Light is observable.
  await page.emulateMedia({ colorScheme: "dark" });
  const html = page.locator("html");
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  try {
    await page.goto("/settings?tab=appearance");
    await expect(html).not.toHaveAttribute("data-theme");
    expect(await bodyBg()).toBe("rgb(18, 18, 17)");
    const group = page.getByRole("radiogroup", { name: "Theme" });
    await expect(group.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");

    await group.getByRole("radio", { name: "Light" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect.poll(bodyBg).toBe("rgb(250, 250, 249)");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
    await expect.poll(async () => (await (await request.get("/api/settings/theme")).json()).theme).toBe("light");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await bodyBg()).toBe("rgb(250, 250, 249)");
    await expect(group.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");

    // Dark while the OS is light.
    await page.emulateMedia({ colorScheme: "light" });
    await group.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect.poll(bodyBg).toBe("rgb(18, 18, 17)");

    await group.getByRole("radio", { name: "System" }).click();
    await expect(html).not.toHaveAttribute("data-theme");
    await expect.poll(bodyBg).toBe("rgb(250, 250, 249)");
    await expect.poll(async () => (await (await request.get("/api/settings/theme")).json()).theme).toBe("system");
  } finally {
    await request.put("/api/settings/theme", { data: { theme: "system" } });
  }
});

test("assets: \\ a opens net worth with history; Cash, a starting balance, Investments and 中文", async ({ page }) => {
  await page.goto("/transactions?month=2026-09");
  await expect(page.getByRole("row").first()).toBeVisible();
  await page.keyboard.press("\\");
  await page.keyboard.press("a");
  await expect(page).toHaveURL(/\/assets$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main navigation" }).locator("[aria-current=page]")).toHaveText("Assets");
  const views = page.getByRole("navigation", { name: "Assets view" });
  await expect(views.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");

  // All: net worth (converted with its rate, or per currency when Frankfurter cannot be reached), history, by currency.
  await expect(page.getByTestId("assets-net-worth")).toBeVisible();
  await expect(page.getByRole("region", { name: "Net worth" })).toContainText(/in USD · CNY at [\d.]+ on|no exchange rate|not available/);
  await expect(page.getByRole("img", { name: /^Net worth from \w{3} \d{1,2}, 2026 to/ })).toBeVisible();
  // One chart, four lines on a labelled scale; each line switches off from its chip, hover shows the visible ones.
  const history = page.getByTestId("assets-history");
  const legend = history.getByRole("group", { name: "Lines shown" });
  await expect(legend.getByRole("button")).toHaveText(["Net worth", "Cash", "Investments", "Credit cards"]);
  await expect(history).toContainText(/\$\d{1,3}(,\d{3})*(K|M)?/);
  await legend.getByRole("button", { name: "Cash" }).click();
  await expect(legend.getByRole("button", { name: "Cash" })).toHaveAttribute("aria-pressed", "false");
  await history.getByRole("img").hover();
  const tip = history.getByTestId("chart-tooltip");
  await expect(tip).toContainText(/Net worth\s*\$[\d,.]+/);
  await expect(tip).toContainText("Investments");
  await expect(tip).not.toContainText("Cash");
  await legend.getByRole("button", { name: "Cash" }).click();
  await expect(legend.getByRole("button", { name: "Cash" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("assets-by-currency")).toContainText(/CNY[\s\S]*HKD[\s\S]*USD/);
  await expect(page.getByTestId("assets-cash-flow")).toHaveAttribute("href", /^\/analysis\?from=\d{4}-\d{2}-\d{2}&to=/);
  const cash = page.getByTestId("assets-cash-card");
  await expect(cash.getByTestId("assets-account-row").filter({ hasText: "Alipay balance" })).toContainText("Starting balance Jun 30 + transactions");
  await expect(cash.getByTestId("assets-account-row").filter({ hasText: "ICBC credit card 0003" })).toContainText(/Statement balance · Sep 29[\s\S]*−\$[\d,.]+[\s\S]*Owed to the bank/);
  await expect(cash.getByTestId("assets-account-row").filter({ hasText: "Bank of America Adv Plus Banking 5501" })).toContainText("Balance from bank · Sep 29");
  const holdings = page.getByTestId("assets-holdings-card");
  await expect(holdings).toContainText(/IBKR U0000001 · As of Sep 28 close/);
  await expect(holdings.getByTestId("assets-holding-row").filter({ hasText: "AAPL" })).toContainText("229.87");

  await page.getByRole("navigation", { name: "History range" }).getByRole("link", { name: "1M" }).click();
  await expect(page).toHaveURL(/\/assets\?range=1m$/);
  await expect(page.getByRole("navigation", { name: "History range" }).getByRole("link", { name: "1M" })).toHaveAttribute("aria-current", "page");

  // Cash: per-currency cash, account rows, and a starting balance for the manual account.
  await views.getByRole("link", { name: "Cash" }).click();
  await expect(page).toHaveURL(/\/assets\?view=cash&range=1m$/);
  await expect(page.getByRole("region", { name: "CNY cash" })).toBeVisible();
  await expect(page.getByRole("region", { name: "USD cash" })).toContainText("Cards");
  const manual = page.getByTestId("assets-accounts").getByTestId("assets-account-row").filter({ hasText: "Manual entries" });
  await expect(manual).toContainText("No balance yet");
  await manual.getByRole("button", { name: "Set a starting balance" }).click();
  const dialog = page.getByRole("dialog", { name: "Set a starting balance" });
  await expect(dialog.getByRole("combobox")).toHaveValue(/\d+/);
  await dialog.getByRole("textbox", { name: /Balance \(USD\)/ }).fill("42.50");
  await dialog.getByRole("button", { name: "Save starting balance" }).click();
  await expect(page.getByText("Starting balance saved for Manual entries")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(manual).toContainText(/Starting balance \w{3} \d{1,2} \+ transactions[\s\S]*\$42\.50/);

  // Investments: positions per brokerage, allocation, dividends and trades, value or P/L history, sources.
  await views.getByRole("link", { name: "Investments" }).click();
  await expect(page).toHaveURL(/\/assets\?view=investments&range=1m$/);
  const ibkr = page.getByRole("table", { name: "Positions in IBKR U0000001" });
  await expect(ibkr.getByRole("row").filter({ hasText: "AAPL" })).toContainText("229.87");
  const rh = page.getByRole("table", { name: "Positions in Robinhood Individual 0004" });
  await expect(rh.getByRole("row").filter({ hasText: "NVDA" })).toContainText("3.52718");
  await expect(rh.getByRole("row").filter({ hasText: "USD cash" })).toContainText("$86.12");
  await expect(page.getByTestId("assets-allocation").getByTestId("assets-allocation-row").first()).toBeVisible();
  await expect(page.getByTestId("assets-activity")).toContainText(/Dividend VTI[\s\S]*\+\$35\.84/);
  await expect(page.getByTestId("assets-activity")).toContainText(/Buy VTI[\s\S]*−\$1,480\.25/);
  // Value against net deposits since the first day shown; dividends as dots on the value line (the chart needs one
  // currency, so it is there only when the exchange rate could be fetched).
  const invest = page.getByTestId("assets-invest-history");
  if (await page.getByTestId("assets-rate").count()) {
    await expect(invest.getByRole("group", { name: "Lines shown" }).getByRole("button")).toHaveText(["Holdings value", /^Net deposits since \w{3} \d{1,2}, 2026$/]);
    await expect(page.getByTestId("assets-deposits-hint")).toContainText("the gap between the two lines is market gain or loss");
    await expect(invest.getByTestId("chart-marker").first()).toBeAttached();
  }
  const chart = page.getByRole("navigation", { name: "History shows" });
  if (await chart.count()) {
    await chart.getByRole("link", { name: "P/L" }).click();
    await expect(page).toHaveURL(/chart=pnl/);
    await expect(page.getByRole("img", { name: /^Unrealized P\/L from/ })).toBeVisible();
  }
  await expect(page.getByTestId("ibkr-setup").getByRole("link", { name: "Set up Interactive Brokers" })).toHaveAttribute("href", "/settings?tab=connections");
  await expect(page.getByTestId("assets-sources")).toContainText("Robinhood");

  // Analysis links back with the net worth change over its period.
  await page.goto("/analysis?preset=last_month");
  const nw = page.getByTestId("stats-net-worth");
  await expect(nw).toContainText(/^Net worth change in this period: [+−]/);
  await nw.getByRole("link", { name: "Assets" }).click();
  await expect(page).toHaveURL(/\/assets$/);

  await page.goto("/settings");
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.goto("/assets?view=cash");
  await expect(page.getByRole("navigation", { name: "资产视图" }).getByRole("link", { name: "现金" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("assets-accounts").getByTestId("assets-account-row").filter({ hasText: "支付宝余额" })).toContainText("6月30日 期初余额 + 之后的交易");
  await page.goto("/assets?view=investments");
  await expect(page.getByRole("table", { name: "Robinhood Individual 0004 的持仓" }).getByRole("row").filter({ hasText: "USD 现金" })).toBeVisible();
  await page.goto("/settings");
  await page.getByRole("group", { name: "语言" }).getByRole("button", { name: "EN" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("import: each source has a collapsed how-to guide that links to its GitHub guide", async ({ page }) => {
  await page.goto("/import");
  const guides = page.getByTestId("import-guides");
  await expect(guides.locator("details")).toHaveCount(5);
  await expect(guides.locator("details[open]")).toHaveCount(0);
  const boa = page.getByTestId("import-guide-boa");
  await boa.locator("summary").click();
  await expect(boa).not.toContainText("Last checked");
  await expect(boa.getByRole("link", { name: "guide on GitHub" })).toHaveAttribute("href", "https://github.com/averatec0773/yomi/blob/main/guides/import-boa.md");
  await expect(page.getByTestId("import-guide-sms").getByRole("link", { name: "guide on GitHub", includeHidden: true })).toHaveAttribute("href", /import-icbc\.md#sms-alerts$/);
});
