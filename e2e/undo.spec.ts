import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

test("undo and redo a column change and a search with Ctrl+Z / Ctrl+Shift+Z", async ({ page }) => {
  await mockTauri(page, {
    startupFiles: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    views: () => 3,
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("1,000 rows");
  const show = page.getByRole("checkbox", { name: "Show name" });

  await show.uncheck();
  await expect(show).not.toBeChecked();
  await page.keyboard.press("Control+z");
  await expect(show).toBeChecked();
  await expect(page.getByRole("status")).toContainText("Undid the change to the columns");
  await page.keyboard.press("Control+Shift+z");
  await expect(show).not.toBeChecked();

  const search = page.getByPlaceholder("Search text columns");
  await search.fill("Alice");
  await search.press("Enter");
  await expect(page.getByRole("status")).toContainText("3 of 1,000 rows");
  // In the search box, Ctrl+Z edits the text; outside it, it undoes the search.
  await page.getByRole("tab", { name: /comma\.csv/ }).focus();
  await page.keyboard.press("Control+z");
  await expect(search).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("Undid the change to the search");
  await page.keyboard.press("Control+y");
  await expect(search).toHaveValue("Alice");

  // Also in the Edit menu.
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByRole("menuitem", { name: "Undo filter, sort or column change" }).click();
  await expect(search).toHaveValue("");
});
