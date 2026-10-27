import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`app shell follows the OS ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Drop a CSV/ })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`shell-${scheme}.png`);
  });
}

test("theme toggle overrides the OS theme and persists", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Theme: follow system" }).click();
  await page.getByRole("button", { name: "Theme: light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
