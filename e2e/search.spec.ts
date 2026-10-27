import { expect, test } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { gridCell, mockTauri } from "./tauri-mock";

interface Spec {
  search?: string;
  filters?: unknown[];
}

const views: Spec[] = [];

function buildPage(start: number, count: number, datasetId: string): string {
  const tag = datasetId.startsWith("view-") ? "Smith" : "name";
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `${tag} ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

test("Ctrl+F searches text columns; Escape clears", async ({ page }) => {
  views.length = 0;
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: (spec) => {
      views.push(spec as Spec);
      return 42;
    },
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  const status = page.getByRole("status");
  await expect(status).toContainText("1,000 rows");
  await page.getByTestId("data-grid").click({ position: { x: 300, y: 80 } });

  await page.keyboard.press("Control+f");
  const box = page.getByLabel("Search text columns");
  await expect(box).toBeFocused();
  await page.keyboard.type("smith");
  await expect(status).toContainText("42 of 1,000 rows · filtered in 15 ms");
  // One request, after typing stopped.
  expect(views).toEqual([{ search: "smith" }]);
  await expect(gridCell(page, "Smith 1")).toBeAttached();

  // Search combines with filters.
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("button", { name: "amount", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Filter amount" });
  await editor.getByLabel("Value").fill("1");
  await editor.getByRole("button", { name: "Apply" }).click();
  await expect
    .poll(() => views.at(-1))
    .toEqual({ search: "smith", filters: [{ column: "amount", op: "equals", value: 1 }] });

  // Escape clears the search; the filter stays.
  await box.focus();
  await page.keyboard.press("Escape");
  await expect(box).toHaveValue("");
  await expect
    .poll(() => views.at(-1))
    .toEqual({ filters: [{ column: "amount", op: "equals", value: 1 }] });
});
