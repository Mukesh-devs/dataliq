import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { gridCell, mockTauri } from "./tauri-mock";

const STATUS = ["changed", "removed", "changed", "added"];

/** A file's rows, or a comparison's (`diff-` datasets). */
function buildPage(start: number, count: number, datasetId: string): string {
  const n = (i: number) => start + i + 1;
  const table = datasetId.startsWith("diff-")
    ? tableFromArrays({
        status: Array.from({ length: count }, (_, i) => STATUS[(start + i) % 4]!),
        id: BigInt64Array.from({ length: count }, (_, i) => BigInt(n(i))),
        changed: Array.from({ length: count }, (_, i) =>
          STATUS[(start + i) % 4] === "changed" ? "amount" : null,
        ),
        name: Array.from({ length: count }, (_, i) => `name ${n(i)}`),
        amount: Float64Array.from({ length: count }, (_, i) => n(i) + 0.5),
        "amount (before)": Array.from({ length: count }, (_, i) =>
          STATUS[(start + i) % 4] === "changed" ? n(i) : null,
        ),
      })
    : tableFromArrays({
        id: BigInt64Array.from({ length: count }, (_, i) => BigInt(n(i))),
        name: Array.from({ length: count }, (_, i) => `name ${n(i)}`),
        amount: Float64Array.from({ length: count }, (_, i) => n(i)),
      });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

const comparison = {
  rowCount: 40,
  columns: [
    { name: "status", type: "VARCHAR" },
    { name: "id", type: "BIGINT" },
    { name: "changed", type: "VARCHAR" },
    { name: "name", type: "VARCHAR" },
    { name: "amount", type: "DOUBLE" },
    { name: "amount (before)", type: "DOUBLE" },
  ],
  leftRows: 1000,
  rightRows: 990,
  added: 10,
  removed: 20,
  changed: 10,
  same: 960,
  duplicateLeft: 0,
  duplicateRight: 2,
  compared: ["name", "amount"],
  onlyLeft: [],
  onlyRight: ["city"],
  retyped: [],
  changes: [{ name: "amount", rows: 10 }],
};

type Invoke = { cmd: string; args: Record<string, unknown> };
const invokes = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (window as unknown as { __invokes: Invoke[] }).__invokes
        .filter((i) => i.cmd === c)
        .map((i) => i.args),
    cmd,
  );

/** Pixels of the grid canvas close to `rgb`. */
function countColor(page: Page, rgb: [number, number, number]) {
  return page.evaluate((target) => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='data-grid'] canvas");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i]! - target[0]) < 5 &&
        Math.abs(data[i + 1]! - target[1]) < 5 &&
        Math.abs(data[i + 2]! - target[2]) < 5
      )
        n++;
    }
    return n;
  }, rgb);
}

const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");

test("compare two open files: counts, filtered rows, highlighted cells", async ({ page }) => {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv", "/data/semicolon.csv"],
    datasets: { "/data/comma.csv": 1000, "/data/semicolon.csv": 990 },
    fetchRows: buildPage,
    views: () => 20,
    comparison,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(status(page)).toContainText("1,000 rows");
  await page.keyboard.press("Control+o");
  await expect(page.getByRole("tab", { name: /semicolon\.csv/ })).toBeVisible();
  await expect(status(page)).toContainText("rows");

  // From comma.csv (before) to semicolon.csv (after), by id.
  await page.getByRole("tab", { name: /comma\.csv/ }).click();
  await page.getByRole("button", { name: /^Compare/ }).click();
  const dialog = page.getByRole("dialog", { name: "Compare files" });
  await expect(dialog.getByLabel("Other file")).toHaveValue(/tab-/);
  await expect(dialog.getByRole("checkbox", { name: "id" })).toBeChecked();
  await dialog.getByRole("button", { name: "Compare", exact: true }).click();
  expect((await invokes(page, "compare_files")).at(-1)).toMatchObject({
    spec: { keys: ["id"] },
    group: expect.stringMatching(/^compare:/) as unknown,
  });

  // A new tab with the differences.
  await expect(page.getByRole("tab", { name: "comma.csv ↔ semicolon.csv" })).toBeVisible();
  const bar = page.getByRole("region", { name: "Comparison" });
  await expect(bar).toContainText("1,000 → 990 rows, matched by “id”:");
  await expect(bar).toContainText("960 the same");
  await expect(bar).toContainText("Only after: “city” (not compared).");
  await expect(status(page)).toContainText("40 rows · compared in 12 ms");
  await expect(gridCell(page, "removed").first()).toBeAttached();

  // Changed cells and added rows are filled (light theme tokens over white).
  await expect.poll(() => countColor(page, [253, 236, 206])).toBeGreaterThan(200);
  await expect.poll(() => countColor(page, [222, 242, 230])).toBeGreaterThan(200);

  // A count shows only those rows.
  await bar.getByRole("button", { name: "20 removed" }).click();
  expect((await invokes(page, "open_view")).at(-1)).toMatchObject({
    datasetId: "diff-1",
    spec: { filters: [{ column: "status", op: "equals", value: "removed" }] },
  });
  await expect(bar.getByRole("button", { name: "20 removed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await bar.getByRole("button", { name: "10 changed" }).click();
  expect((await invokes(page, "open_view")).at(-1)).toMatchObject({
    spec: { filters: [{ column: "status", op: "equals", value: "changed" }] },
  });
  // The diff exports like any view.
  await expect(page.getByRole("button", { name: /^Export/ })).toBeEnabled();
});
