import { expect, test } from "./fixtures";

// The clock is pinned to Wed Sep 30 2026, noon in Chicago (playwright.config.ts E2E_NOW). The demo ledger
// (packages/core/src/cli/demo.ts) has Alipay and ICBC through Sep 29 and a WeChat export that ends on Sep 24.

test("analysis: Day opens on yesterday, steps to today (so far) and stops there; CNY is partial, USD is not", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/analysis");
  const kinds = page.getByRole("navigation", { name: "View by" });
  await kinds.getByRole("link", { name: "Day" }).click();
  await expect(page).toHaveURL(/\/analysis\?preset=yesterday$/);
  const bar = page.getByRole("navigation", { name: "Period" });
  await expect(bar).toContainText("Tue, Sep 29, 2026");
  await expect(kinds.getByRole("link", { name: "Day" })).toHaveAttribute("aria-current", "page");

  const cny = page.getByTestId("day-CNY");
  const usd = page.getByTestId("day-USD");
  await expect(cny).toContainText("CNY spent on Tue, Sep 29");
  await expect(cny.getByTestId("insight-partial")).toContainText("Partial: WeChat through Sep 24");
  await expect(usd.getByTestId("insight-partial")).toHaveCount(0);
  await expect(usd.getByTestId("insight-typical")).toContainText("a typical day (last 28 days)");
  await expect(usd.getByTestId("insight-unusual")).toContainText("Larger than usual at Busy Bee Cafe");
  await expect(usd.getByTestId("day-rows")).toContainText("ICBC credit card");
  await expect(page.getByTestId("day-arrived")).toContainText(/\d+ from ICBC credit card/);
  await expect(page.getByTestId("day-arrived")).toContainText(/\d+ from Alipay/);
  // Holdings in the demo end on Sep 28, so Tuesday's close is not in yet.
  await expect(page.getByTestId("day-close")).toContainText("The close for Sep 29 is not in yet; holdings are known through Sep 28.");

  // One step forward is today, labelled "so far"; there is no next day yet.
  await bar.getByRole("link", { name: "Next period" }).click();
  await expect(page).toHaveURL(/preset=today/);
  await expect(bar).toContainText("Wed, Sep 30, 2026 · so far");
  await expect(bar.getByRole("link", { name: "Next period" })).toHaveAttribute("aria-disabled", "true");
  await bar.getByRole("link", { name: "Previous period" }).click();
  await expect(bar).toContainText("Tue, Sep 29, 2026");
  await bar.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/from=2026-09-28&to=2026-09-28/);
  await expect(page.getByRole("form", { name: "Custom range" })).toHaveCount(0);
});

test("analysis: Week is Monday to Sunday so far, steps by seven days; Month keeps Insights inside the summary card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/analysis?preset=this_week");
  const bar = page.getByRole("navigation", { name: "Period" });
  await expect(bar).toContainText("Sep 28 – Oct 4, 2026 · so far");
  await expect(page.getByRole("region", { name: "USD stats" })).toContainText(/a day (more|less) than last week/);
  // Sep 28 to Oct 4 touches two months, but a week shows no monthly trend.
  await expect(page.getByRole("heading", { name: /Monthly spending/ })).toHaveCount(0);
  // The right-hand card starts on the largest rows; Top merchants switches in place.
  const cnyList = page.getByRole("region", { name: "CNY stats" }).getByTestId("largest-card");
  await expect(cnyList.getByRole("radio", { name: "Largest" })).toHaveAttribute("aria-checked", "true");
  await cnyList.getByRole("radio", { name: "Top merchants" }).click();
  await expect(cnyList.getByRole("radio", { name: "Top merchants" })).toHaveAttribute("aria-checked", "true");
  await expect(cnyList).toContainText("滴滴出行");
  await expect(page).toHaveURL(/preset=this_week$/);
  await bar.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/preset=last_week/);
  await expect(bar).toContainText("Sep 21 – 27, 2026");
  await bar.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/from=2026-09-14&to=2026-09-20/);
  await expect(page.getByRole("form", { name: "Custom range" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "View by" }).getByRole("link", { name: "Month" }).click();
  await expect(page).toHaveURL(/preset=this_month/);
  await expect(bar).toContainText("September 2026 · so far");
  // One line under the header: net worth, then investments.
  await expect(page.getByTestId("stats-net-worth")).toContainText(/^Net worth change in this period: [+−].*Investments [+−]/);
  await expect(page.getByTestId("insights-investments")).toHaveCount(0);
  const usdSection = page.getByRole("region", { name: "USD stats" });
  const cnySection = page.getByRole("region", { name: "CNY stats" });
  const usd = page.getByTestId("insights-USD");
  const cny = page.getByTestId("insights-CNY");
  await expect(usdSection).toContainText(/a day (more|less) than last month/);
  await expect(usd.getByTestId("insight-partial")).toHaveCount(0);
  await expect(usd).toContainText("First time at Bright Screens Electronics");
  // The target editor shows the gap; Insights do not repeat it.
  await expect(usdSection).toContainText("Over by");
  await expect(usd).not.toContainText("target");
  // At most three lines until "+N more" expands the rest in place.
  await expect(usd.getByRole("listitem")).toHaveCount(3);
  const more = usd.getByRole("button", { name: /^\+\d+ more$/ });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(usd.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  await expect(usd.getByRole("listitem")).not.toHaveCount(3);
  // The summary card, Insights included, fits the first screen at 1280×800.
  await page.getByRole("button", { name: "Show less" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  const card = await usd.evaluate((el) => el.closest(".rounded-xl")!.getBoundingClientRect().bottom);
  expect(card).toBeLessThanOrEqual(800);
  await expect(usdSection.getByTestId("largest-card")).toContainText("Bright Screens Electronics");
  // A partial currency leads with the partial line and hides its comparison.
  await expect(cny.getByTestId("insight-partial")).toContainText("Partial: WeChat through Sep 24");
  await expect(cnySection).not.toContainText("than last month");
  await expect(cny).toContainText("Possible duplicate at 喜茶");
  // Summary card (hero, then Insights) before the categories and the largest rows; no monthly trend inside one month.
  const order = await usdSection.evaluate((el) => {
    const pos = (sel: string) => [...el.querySelectorAll("*")].findIndex((n) => n.matches(sel));
    return [pos(".text-hero"), pos("[data-testid=insights-USD]"), pos("[data-testid=largest-card]")];
  });
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);
  await expect(usdSection.getByRole("heading", { name: /Monthly spending/ })).toHaveCount(0);

  await bar.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/preset=last_month/);
  await expect(bar).toContainText("August 2026");
  await expect(page.getByTestId("insights-CNY").getByTestId("insight-partial")).toHaveCount(0);

  // A custom range keeps the comparison and the full numbers, without Insights.
  await page.goto("/analysis?from=2026-09-05&to=2026-09-20");
  await expect(page.getByRole("region", { name: "USD stats" })).toContainText("the previous 16 days");
  await expect(page.getByTestId("insights-USD")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "USD stats" }).getByTestId("largest-card")).toBeVisible();
});

test("analysis: Sources lists how far each source reaches; phones keep four tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/analysis?preset=this_week");
  await page.getByTestId("sources-button").click();
  const list = page.getByTestId("sources-list");
  await expect(list.getByRole("listitem").filter({ hasText: "WeChat" })).toContainText(/Behind\s*Through Sep 24/);
  await expect(list.getByRole("listitem").filter({ hasText: "Alipay" })).toContainText(/Up to date\s*Through Sep 29/);
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/analysis?preset=yesterday");
  const tabs = page.getByRole("navigation", { name: "Main navigation" }).last();
  await expect(tabs.getByRole("link")).toHaveText(["Transactions", "Analysis", "Assets", "Tools"]);
  await expect(tabs.getByRole("link", { name: "Analysis" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("day-CNY")).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);

  // Month on a phone: one column, and the list switch and "+N more" keep 44px targets.
  await page.goto("/analysis?preset=this_month");
  const usd = page.getByTestId("insights-USD");
  await expect(usd).toBeVisible();
  const hits = await page.evaluate(() => {
    const els = [...document.querySelectorAll("[data-testid=insights-USD] button, [data-testid=largest-card] [role=radio]")];
    return els.map((el) => {
      const after = getComputedStyle(el, "::after");
      return Math.min(parseFloat(after.width), parseFloat(after.height));
    });
  });
  expect(hits.length).toBeGreaterThan(2);
  for (const h of hits) expect(h).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
