import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

test("first run: three tips, then they stay closed", async ({ page }) => {
  await mockTauri(page);
  await page.goto("/");
  const tips = page.getByRole("region", { name: "Getting started" });
  await expect(tips).toContainText("Tip 1 of 3");
  await tips.getByRole("button", { name: /Next/ }).click();
  await expect(tips).toContainText("Sort, filter and look closer");
  await tips.getByRole("button", { name: /Next/ }).click();
  await expect(tips).toContainText("Everything is a command");
  await tips.getByRole("button", { name: "Got it" }).click();
  await expect(tips).toBeHidden();

  await page.reload();
  await expect(page.getByRole("button", { name: /Try a sample dataset/ })).toBeVisible();
  await expect(tips).toBeHidden();

  // Help › Show getting-started tips brings them back, in a dialog.
  const bar = page.getByRole("menubar", { name: "Menu bar" });
  await bar.getByRole("menuitem", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: "Show getting-started tips" }).click();
  const dialog = page.getByRole("dialog", { name: "Getting-started tips" });
  await expect(dialog).toContainText("Tip 1 of 3");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the sample dataset opens in a tab", async ({ page }) => {
  await mockTauri(page, { datasets: { "/data/comma.csv": 1000 } });
  await page.goto("/");
  await page.getByRole("button", { name: /Try a sample dataset/ }).click();
  await expect(page.getByRole("tab", { name: /comma\.csv/ })).toBeVisible();

  // Also from the Help menu with a file open.
  const bar = page.getByRole("menubar", { name: "Menu bar" });
  await bar.getByRole("menuitem", { name: "Help" }).click();
  await expect(page.getByRole("menuitem", { name: "Open the sample dataset" })).toBeEnabled();
});
