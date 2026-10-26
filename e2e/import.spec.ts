import { expect, test } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { gridCell, mockTauri } from "./tauri-mock";

const ROWS = 48_210_331;

function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

test("background import shows progress, then the grid switches to the full data", async ({
  page,
}) => {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    imports: { "/data/comma.csv": { progress: [30, 70], rows: ROWS, stepMs: 1000 } },
    fetchRows: buildPage,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  // Preview first.
  await expect(gridCell(page, "Alice")).toBeAttached();
  const bar = page.getByRole("progressbar", { name: "Importing full file" });
  await expect(bar).toContainText("30%");
  await expect(bar).toContainText("70%");
  // Then the full dataset, paged from the backend.
  await expect(page.getByRole("status")).toContainText("48,210,331 rows · imported in 4.20 s");
  await expect(bar).toBeHidden();
  await expect(gridCell(page, "name 1")).toBeAttached();
});

test("cancelling an import keeps the preview", async ({ page }) => {
  // No import plan: the import never finishes on its own.
  await mockTauri(page, { dialogPaths: ["/data/semicolon.csv"] });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("progressbar")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  const cancelled = await page.evaluate(() =>
    (window as unknown as { __invokes: { cmd: string }[] }).__invokes.some(
      (i) => i.cmd === "cancel_import",
    ),
  );
  expect(cancelled).toBe(true);
  await expect(gridCell(page, "München")).toBeAttached();
});

test("the grid loads pages after the import even when the row count is unchanged", async ({
  page,
}) => {
  // Preview and full data both have 3 rows, so the visible region does not
  // change when the grid switches to the imported dataset. The import takes
  // long enough that the preview is reliably seen first.
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    imports: { "/data/comma.csv": { progress: [], rows: 3, stepMs: 1500 } },
    fetchRows: buildPage,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(gridCell(page, "Alice")).toBeAttached();
  await expect(page.getByRole("status")).toContainText("3 rows · imported in");
  await expect(gridCell(page, "name 1")).toBeAttached();
  await expect(gridCell(page, "name 3")).toBeAttached();
});

test("several files imported at once all load their rows", async ({ page }) => {
  await mockTauri(page, {
    startupFiles: ["/data/comma.csv", "/data/semicolon.csv"],
    imports: {
      "/data/comma.csv": { progress: [], rows: 3, stepMs: 200 },
      "/data/semicolon.csv": { progress: [], rows: 3, stepMs: 400 },
    },
    fetchRows: buildPage,
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "semicolon.csv" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("status")).toContainText("3 rows · imported in");
  await expect(gridCell(page, "name 1")).toBeAttached();
  await page.getByRole("tab", { name: "comma.csv" }).click();
  await expect(gridCell(page, "name 2")).toBeAttached();
});
