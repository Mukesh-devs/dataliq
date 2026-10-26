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
