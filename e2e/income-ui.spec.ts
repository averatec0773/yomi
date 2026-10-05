import { expect, expectNoHScroll, test } from "./fixtures";

// The demo ledger (packages/core/src/cli/demo.ts) has September income on the BoA checking account: two paychecks,
// family support and a reimbursement (not counted), the ICBC rebate as cashback, and a CMB → Alipay transfer pair.

test("analysis: the summary card reads Income · Net · Saved; Categories switches to income with a Not counted part", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/analysis?preset=this_month");
  const usd = page.getByRole("region", { name: "USD stats" });
  const line = usd.getByTestId("cash-flow");
  await expect(line).toContainText("Income +$6,908.30 (+$42.50 not counted)");
  await expect(line).toContainText("Net +$4,650.18");
  await expect(line).toContainText("Saved 67%");
  await expect(line).toContainText("Paid for others $419.49");
  // The line is inside the summary card, which still fits the first screen.
  const bottom = await line.evaluate((el) => el.closest(".rounded-xl")!.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual(800);
  // CNY is partial: the line shows, the comparison does not.
  const cny = page.getByRole("region", { name: "CNY stats" });
  await expect(cny.getByTestId("cash-flow")).toContainText("Income +¥824.00");
  await expect(cny).not.toContainText("than last month");

  const card = usd.getByTestId("categories-card");
  await expect(card.getByRole("radio", { name: "Spending" })).toHaveAttribute("aria-checked", "true");
  await expect(card).toContainText("Groceries");
  await card.getByRole("radio", { name: "Income" }).click();
  await expect(card.getByRole("radio", { name: "Income" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("link")).toHaveText([/Salary.*\$6,200\.00/, /Family support.*\$700\.00/, /Cashback.*\$8\.30/, /Reimbursements.*\$42\.50/]);
  await expect(card).toContainText(/Cashback[\s\S]*Not counted[\s\S]*Reimbursements/);
  await card.getByRole("link", { name: /Salary/ }).click();
  await expect(page).toHaveURL(/\/transactions\?.*kind=income.*categoryId=\d+|\/transactions\?.*categoryId=\d+.*kind=income/);
  await expect(page.getByRole("row").filter({ hasText: "Lakeside Lab payroll" })).toHaveCount(2);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/analysis?preset=this_month");
  await expect(page.getByRole("region", { name: "USD stats" }).getByTestId("cash-flow")).toContainText("Saved 67%");
  await expectNoHScroll(page, 375);
});

test("transactions: the Type filter narrows to income or transfers, transfer legs name the other account", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/transactions?month=2026-09");
  const type = page.getByRole("button", { name: "Filter by type" });
  await expect(type).toHaveText("All types");
  await type.click();
  await page.getByRole("menuitem", { name: "Income" }).click();
  await expect(page).toHaveURL(/kind=income/);
  await expect(type).toHaveText("Income");
  const payroll = page.getByRole("row").filter({ hasText: "Lakeside Lab payroll" }).first();
  await expect(payroll).toContainText("Salary");
  await expect(page.getByRole("row").filter({ hasText: "Conference travel reimbursement" })).toContainText("Reimbursements");
  await expect(page.getByRole("row").filter({ hasText: "Online Payment Thank You" })).toHaveCount(0);

  await type.click();
  await page.getByRole("menuitem", { name: "Transfers" }).click();
  await expect(page).toHaveURL(/kind=transfer/);
  await expect(page.getByRole("row").filter({ hasText: "Transfer · China Merchants Bank debit card 0001" })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "Transfer · Alipay balance" })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "Lakeside Lab payroll" })).toHaveCount(0);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/kind=/);
  await expect(type).toHaveText("All types");
});

test("quick-add: income and a transfer between my accounts from the Income and Transfer forms", async ({ page }) => {
  await page.goto("/transactions?month=2026-09");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Income" }).click();
  await dialog.getByRole("textbox", { name: "Amount" }).fill("25");
  await dialog.getByRole("combobox", { name: "Category" }).selectOption({ label: "Cashback & rebates" });
  await dialog.getByRole("combobox", { name: "Account" }).selectOption({ label: "Bank of America Adv Plus Banking 5501 (USD)" });
  await dialog.getByRole("textbox", { name: "Note (optional)" }).fill("Card cashback");
  await dialog.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByText("Added income $25.00")).toBeVisible();

  await dialog.getByRole("radio", { name: "Transfer" }).click();
  await dialog.getByRole("combobox", { name: "From" }).selectOption({ label: "WeChat balance (CNY)" });
  await dialog.getByRole("combobox", { name: "To" }).selectOption({ label: "WeChat balance (CNY)" });
  await expect(dialog).toContainText("Pick two different accounts.");
  await expect(dialog.getByRole("button", { name: "Record transfer" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "To" }).selectOption({ label: "Alipay balance (CNY)" });
  await dialog.getByRole("textbox", { name: "Amount" }).fill("80");
  await dialog.getByRole("button", { name: "Record transfer" }).click();
  await expect(page.getByText("Recorded a transfer of ¥80.00")).toBeVisible();
  await page.keyboard.press("Escape");

  const cashback = page.getByRole("row").filter({ hasText: "Card cashback" });
  await expect(cashback).toContainText("Cashback & rebates");
  await expect(cashback).toContainText("+$25.00");
  await expect(page.getByRole("row").filter({ hasText: "Transfer · WeChat balance" }).filter({ hasText: "¥80.00" })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "Transfer · Alipay balance" }).filter({ hasText: "¥80.00" })).toHaveCount(1);
});

test("settings: an income category's switch moves it in and out of the income total", async ({ page }) => {
  await page.goto("/settings?tab=categories");
  const list = page.getByTestId("income-categories");
  const reimbursements = list.getByRole("switch", { name: "Reimbursements" });
  await expect(reimbursements).toHaveAttribute("aria-checked", "false");
  await expect(list.getByRole("switch", { name: "Salary" })).toHaveAttribute("aria-checked", "true");
  await reimbursements.click();
  await expect(page.getByText("Reimbursements counts as income")).toBeVisible();
  await expect(reimbursements).toHaveAttribute("aria-checked", "true");

  await page.goto("/analysis?preset=this_month");
  const line = page.getByRole("region", { name: "USD stats" }).getByTestId("cash-flow");
  await expect(line).toContainText("Income +$");
  await expect(line).not.toContainText("not counted");

  await page.goto("/settings?tab=categories");
  await reimbursements.click();
  await expect(page.getByText("Reimbursements no longer counts as income")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(reimbursements).toHaveAttribute("aria-checked", "true");
  await reimbursements.click();
  await expect(reimbursements).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(reimbursements).toHaveAttribute("aria-checked", "false");
});
