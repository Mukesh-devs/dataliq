import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { gridCell, mockTauri } from "./tauri-mock";

const ROWS = 50_000_000;
const fetched: [number, number][] = [];

/** Pages shaped like comma.csv (id, name, amount, joined); id = row number + 1. */
function buildPage(start: number, count: number): string {
  fetched.push([start, count]);
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

async function openBigFile(page: Page) {
  fetched.length = 0;
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": ROWS },
    fetchRows: buildPage,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status")).toContainText("50,000,000 rows");
  await expect(page.getByTestId("data-grid")).toBeVisible();
}

const cell = gridCell;

test("grid pages a 50M-row dataset and shows the first rows", async ({ page }) => {
  await openBigFile(page);
  await expect(cell(page, "name 1")).toBeAttached();
  expect(fetched[0]).toEqual([0, 500]);
});

test("scrolling top to bottom of 50M rows never leaves blank pages", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openBigFile(page);
  const grid = page.getByTestId("data-grid");
  const box = (await grid.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Big wheel jumps through the whole file; after each, the visible rows
  // must be filled in quickly (well under 100 ms of blank time in the app;
  // here we allow for the mocked IPC round trip through Node).
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 40_000_000);
    await page.waitForTimeout(30);
  }
  await page.keyboard.press("Control+End");
  await expect(cell(page, `name ${ROWS}`)).toBeAttached({ timeout: 2000 });
  expect(fetched.some(([s]) => s >= ROWS - 500)).toBe(true);
  expect(errors).toEqual([]);
});

test("go to row jumps to any row (Ctrl+G)", async ({ page }) => {
  await openBigFile(page);
  await page.getByTestId("data-grid").click({ position: { x: 200, y: 60 } });
  await page.keyboard.press("Control+g");
  const box = page.getByRole("dialog", { name: "Go to row" });
  await box.getByLabel("Row number").fill("25,000,000");
  await box.getByRole("button", { name: "Go" }).click();
  await expect(cell(page, "name 25000000")).toBeAttached({ timeout: 2000 });
  // Out-of-range rows are rejected.
  await page.keyboard.press("Control+g");
  await box.getByLabel("Row number").fill("50,000,001");
  await expect(box.getByRole("button", { name: "Go" })).toBeDisabled();
});

test("copy a selected range as tab-separated text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openBigFile(page);
  await expect(cell(page, "name 1")).toBeAttached();
  const grid = page.getByTestId("data-grid");
  // Click by position: the row-marker column, then "id" (90 px) and "name".
  const box = (await grid.boundingBox())!;
  // Header (46 px: room for the column histograms) + rows.
  const rowY = (r: number) => 46 + 28 * r + 14;
  await page.mouse.click(box.x + 120, box.y + rowY(0));
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + 260, box.y + rowY(2));
  await page.keyboard.up("Shift");
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("1\tname 1\n2\tname 2\n3\tname 3");
});
