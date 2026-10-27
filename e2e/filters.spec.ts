import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { gridCell, mockTauri } from "./tauri-mock";

interface Spec {
  filters?: { column: string; op: string; [k: string]: unknown }[];
}

const views: Spec[] = [];

/** Rows shaped like comma.csv; view pages are tagged so the test can tell them apart. */
function buildPage(start: number, count: number, datasetId: string): string {
  const tag = datasetId.startsWith("view-") ? "match" : "name";
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `${tag} ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

async function openImported(page: Page) {
  views.length = 0;
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    imports: { "/data/comma.csv": { progress: [], rows: 1000, stepMs: 50 } },
    fetchRows: buildPage,
    views: (spec) => {
      views.push(spec as Spec);
      return 10 * ((spec as Spec).filters?.length ?? 0) + 2;
    },
    values: (column, search) =>
      [
        { value: "Alice", count: 500 },
        { value: "Bob", count: 300 },
        { value: null, count: 7 },
      ].filter((v) => column === "name" && (!search || (v.value ?? "").includes(search))),
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status")).toContainText("1,000 rows");
}

test("add, edit and remove filters; the grid and status follow", async ({ page }) => {
  await openImported(page);
  const status = page.getByRole("status");
  const bar = page.getByRole("toolbar", { name: "Filters" });

  // Add a text filter from the toolbar.
  await bar.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("button", { name: "name", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Filter name" });
  await editor.getByLabel("Value").fill("ann");
  await editor.getByRole("button", { name: "Apply" }).click();
  await expect(bar.getByRole("button", { name: 'Edit filter: name contains "ann"' })).toBeVisible();
  await expect(status).toContainText("12 of 1,000 rows · filtered in 15 ms");
  await expect(gridCell(page, "match 1")).toBeAttached();
  expect(views.at(-1)).toEqual({ filters: [{ column: "name", op: "contains", value: "ann" }] });

  // A second filter, from the column header menu (right-click → Filter…).
  const grid = page.getByTestId("data-grid");
  const box = (await grid.boundingBox())!;
  await page.mouse.click(box.x + 60, box.y + 16, { button: "right" });
  await page
    .getByRole("menu", { name: "id column" })
    .getByRole("menuitem", { name: "Filter…" })
    .click();
  const idEditor = page.getByRole("dialog", { name: "Filter id" });
  await idEditor.getByLabel("Condition").selectOption("gt");
  await idEditor.getByLabel("Value").fill("100");
  await idEditor.getByRole("button", { name: "Apply" }).click();
  await expect(status).toContainText("22 of 1,000 rows");
  expect(views.at(-1)?.filters).toEqual([
    { column: "name", op: "contains", value: "ann" },
    { column: "id", op: "gt", value: 100 },
  ]);

  // Edit the first chip.
  await bar.getByRole("button", { name: 'Edit filter: name contains "ann"' }).click();
  await expect(editor.getByLabel("Value")).toHaveValue("ann");
  await editor.getByLabel("Exclude matching rows").check();
  await editor.getByRole("button", { name: "Apply" }).click();
  await expect(
    bar.getByRole("button", { name: 'Edit filter: name doesn\'t contain "ann"' }),
  ).toBeVisible();
  expect(views.at(-1)?.filters?.[0]).toMatchObject({ not: true });

  // Remove one, then clear the rest: back to the full data.
  await bar.getByRole("button", { name: "Remove filter: id > 100" }).click();
  await expect(status).toContainText("12 of 1,000 rows");
  await bar.getByRole("button", { name: /Remove filter/ }).click();
  await expect(status).toContainText("1,000 rows · imported in");
  await expect(status).not.toContainText(" of ");
  await expect(gridCell(page, "name 1")).toBeAttached();
});

test("pick values from the value list", async ({ page }) => {
  await openImported(page);
  const bar = page.getByRole("toolbar", { name: "Filters" });
  await bar.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("button", { name: "name", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Filter name" });
  await editor.getByLabel("Condition").selectOption("in");
  const values = editor.getByRole("list", { name: "Values" });
  await expect(values).toContainText("Alice500");
  await expect(values).toContainText("null7");
  await editor.getByLabel(/Alice/).check();
  await editor.getByLabel(/null/).check();
  await editor.getByLabel("Search values").fill("Bo");
  await expect(values).not.toContainText("Alice");
  await editor.getByLabel(/Bob/).check();
  await editor.getByRole("button", { name: "Apply" }).click();
  await expect(
    bar.getByRole("button", { name: 'Edit filter: name is one of "Alice", null, "Bob"' }),
  ).toBeVisible();
  expect(views.at(-1)?.filters).toEqual([
    { column: "name", op: "in", values: ["Alice", null, "Bob"] },
  ]);
});

test("filters chosen during the import apply when it finishes", async ({ page }) => {
  views.length = 0;
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    imports: { "/data/comma.csv": { progress: [50], rows: 1000, stepMs: 1500 } },
    fetchRows: buildPage,
    views: (spec) => {
      views.push(spec as Spec);
      return 3;
    },
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(gridCell(page, "Alice")).toBeAttached();
  const bar = page.getByRole("toolbar", { name: "Filters" });
  await bar.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("button", { name: "amount", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Filter amount" });
  await editor.getByLabel("Value").fill("10.5");
  await editor.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("status")).toContainText("Filters apply when the import finishes");
  await expect(page.getByRole("status")).toContainText("3 of 1,000 rows", { timeout: 5000 });
  expect(views).toEqual([{ filters: [{ column: "amount", op: "equals", value: 10.5 }] }]);
});
