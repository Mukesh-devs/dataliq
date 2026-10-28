import { expect, test } from "@playwright/test";
import { emitEvent, gridCell, mockTauri } from "./tauri-mock";

const tab = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("tab", { name, exact: true });

test("open three files, switch and close tabs, then reopen from recent files", async ({ page }) => {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv|/data/semicolon.csv", "/data/nulls.csv", "/data/comma.csv"],
  });
  await page.goto("/");
  // Two files from one dialog, a third with Ctrl+O.
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(tab(page, "semicolon.csv")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+o");
  await expect(tab(page, "nulls.csv")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveCount(3);

  // Ctrl+Tab cycles (wrapping), Ctrl+Shift+Tab goes back.
  await page.keyboard.press("Control+Tab");
  await expect(tab(page, "comma.csv")).toHaveAttribute("aria-selected", "true");
  await expect(gridCell(page, "Alice")).toBeAttached();
  await page.keyboard.press("Control+Shift+Tab");
  await expect(tab(page, "nulls.csv")).toHaveAttribute("aria-selected", "true");

  // Ctrl+W closes the active tab, a tab's close button closes it, and so
  // does Delete on a focused tab; arrows move between tabs.
  await page.keyboard.press("Control+w");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await tab(page, "comma.csv")
    .locator("..")
    .getByTitle(/^Close/)
    .click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("Control+o");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await tab(page, "semicolon.csv").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(":focus")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Delete");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await tab(page, "semicolon.csv").focus();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("tab")).toHaveCount(0);

  // The empty state lists recent files, newest first.
  const recent = page.getByRole("region", { name: "Recent files" }).getByRole("button");
  await expect(recent).toHaveCount(3);
  await expect(recent.first()).toContainText("comma.csv");
  await expect(recent.nth(1)).toContainText("nulls.csv");
  await recent.nth(1).click();
  await expect(tab(page, "nulls.csv")).toBeVisible();
});

test("drag and drop opens files and shows a drop target", async ({ page }) => {
  await mockTauri(page);
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("DuckDB");
  await emitEvent(page, "tauri://drag-enter", {
    paths: ["/data/comma.csv"],
    position: { x: 1, y: 1 },
  });
  await expect(page.getByTestId("drop-zone")).toHaveAttribute("data-dragging", "true");
  await emitEvent(page, "tauri://drag-drop", {
    paths: ["/data/comma.csv"],
    position: { x: 1, y: 1 },
  });
  await expect(tab(page, "comma.csv")).toBeVisible();
  // With a file open, dragging shows an overlay instead.
  await emitEvent(page, "tauri://drag-over", { position: { x: 1, y: 1 } });
  await expect(page.getByTestId("drop-overlay")).toBeVisible();
  await emitEvent(page, "tauri://drag-leave", null);
  await expect(page.getByTestId("drop-overlay")).toBeHidden();
});

test("files from the command line open at startup and from a second launch", async ({ page }) => {
  await mockTauri(page, { startupFiles: ["/data/comma.csv"] });
  await page.goto("/");
  await expect(tab(page, "comma.csv")).toBeVisible();
  // `bigview semicolon.csv` while the app runs: the single-instance plugin
  // forwards the files as an "open-files" event.
  await emitEvent(page, "open-files", ["/data/semicolon.csv", "/data/nulls.csv"]);
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect(tab(page, "nulls.csv")).toHaveAttribute("aria-selected", "true");
});
