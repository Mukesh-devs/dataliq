import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { emitEvent, gridHeader, mockTauri } from "./tauri-mock";

interface Spec {
  filters?: unknown[];
  sort?: { column: string; descending?: boolean }[];
}

const views: Spec[] = [];

function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

async function open(page: Page) {
  views.length = 0;
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: (spec) => {
      views.push(spec as Spec);
      return 1000;
    },
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status")).toContainText("1,000 rows");
  return (await page.getByTestId("data-grid").boundingBox())!;
}

test("clicking headers sorts; Shift adds keys; chips edit the sort", async ({ page }) => {
  const box = await open(page);
  const status = page.getByRole("status");
  const bar = page.getByRole("toolbar", { name: "Filters" });
  // "name" is the second column; click its middle (not the menu button).
  await page.mouse.click(box.x + 180, box.y + 16);
  await expect(status).toContainText(
    "1,000 of 1,000 rows · first rows in 15 ms, sorting the rest…",
  );
  expect(views.at(-1)).toEqual({ sort: [{ column: "name" }] });
  // The full sort finishes in the background.
  await emitEvent(page, "view-ready", { datasetId: "view-1", elapsedMs: 3200 });
  await expect(status).toContainText("1,000 of 1,000 rows · sorted in 3.20 s");
  await expect(gridHeader(page, "name ↑")).toBeAttached();
  await expect(bar.getByRole("button", { name: /Sort by name, ascending/ })).toBeVisible();

  // Again: descending.
  await page.mouse.click(box.x + 180, box.y + 16);
  await expect.poll(() => views.at(-1)).toEqual({ sort: [{ column: "name", descending: true }] });
  await expect(gridHeader(page, "name ↓")).toBeAttached();

  // Shift+click the id column adds a second key.
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + 60, box.y + 16);
  await page.keyboard.up("Shift");
  await expect
    .poll(() => views.at(-1))
    .toEqual({ sort: [{ column: "name", descending: true }, { column: "id" }] });
  await expect(gridHeader(page, "name ↓1")).toBeAttached();
  await expect(gridHeader(page, "id ↑2")).toBeAttached();

  // Chips: reverse the second key, then remove the first.
  await bar.getByRole("button", { name: /Sort by id, ascending/ }).click();
  await expect
    .poll(() => views.at(-1))
    .toEqual({
      sort: [
        { column: "name", descending: true },
        { column: "id", descending: true },
      ],
    });
  await bar.getByRole("button", { name: "Remove sort by name" }).click();
  await expect.poll(() => views.at(-1)).toEqual({ sort: [{ column: "id", descending: true }] });
  await bar.getByRole("button", { name: "Remove sort by id" }).click();
  await expect(status).toContainText("1,000 rows · imported");
  await expect(status).not.toContainText(" of ");
});

test("the column menu sorts and filters", async ({ page }) => {
  const box = await open(page);
  await page.mouse.click(box.x + 180, box.y + 16, { button: "right" });
  const menu = page.getByRole("menu", { name: "name column" });
  await menu.getByRole("menuitem", { name: "Sort descending" }).click();
  await expect.poll(() => views.at(-1)).toEqual({ sort: [{ column: "name", descending: true }] });
  await expect(menu).toBeHidden();

  // Filter… from the same menu opens the filter editor; sort and filter combine.
  await page.mouse.click(box.x + 180, box.y + 16, { button: "right" });
  await menu.getByRole("menuitem", { name: "Filter…" }).click();
  const editor = page.getByRole("dialog", { name: "Filter name" });
  await editor.getByLabel("Value").fill("7");
  await editor.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("status")).toContainText("sorting the rest…");
  await emitEvent(page, "view-ready", { datasetId: "view-2", elapsedMs: 500 });
  await expect(page.getByRole("status")).toContainText("filtered and sorted in 500 ms");
  expect(views.at(-1)).toEqual({
    sort: [{ column: "name", descending: true }],
    filters: [{ column: "name", op: "contains", value: "7" }],
  });
});
