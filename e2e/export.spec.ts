import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

type Invoke = { cmd: string; args: Record<string, unknown> };
const invokes = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (window as unknown as { __invokes: Invoke[] }).__invokes
        .filter((i) => i.cmd === c)
        .map((i) => i.args),
    cmd,
  );

async function open(page: Page, savePaths: (string | null)[], exportMs: number) {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: () => 500,
    savePaths,
    exportMs,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(status(page)).toContainText("1,000 rows");
  return (await page.getByTestId("data-grid").boundingBox())!;
}

const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Export" });

test("export the sorted view without a hidden column, with progress", async ({ page }) => {
  await open(page, [null, "/out/comma-export.parquet"], 4000);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("sort by amount desc");
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("500 of 1,000 rows");
  await page.getByRole("complementary", { name: "Sidebar" }).getByLabel("Show name").uncheck();

  await page.keyboard.press("Control+e");
  await expect(dialog(page)).toContainText("The whole view: 500 rows, 3 columns");
  await dialog(page).getByRole("radio", { name: "Parquet" }).click();
  // The save dialog cancelled: nothing happens, the dialog stays.
  await dialog(page).getByRole("button", { name: "Export 500 rows…" }).click();
  await expect.poll(() => invokes(page, "plugin:dialog|save")).toHaveLength(1);
  await expect(dialog(page)).toBeVisible();
  expect(await invokes(page, "export_view")).toEqual([]);

  await dialog(page).getByRole("button", { name: "Export 500 rows…" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(status(page)).toHaveText(/Exporting comma-export\.parquet… 50%/);
  await expect(page.getByRole("button", { name: "Cancel export" })).toBeVisible();
  await expect(status(page)).toHaveText(/Exported 500 rows to comma-export\.parquet/, {
    timeout: 10_000,
  });
  const [save] = await invokes(page, "plugin:dialog|save");
  expect(save).toMatchObject({ options: { defaultPath: "comma-export.parquet" } });
  const [call] = await invokes(page, "export_view");
  expect(call).toMatchObject({
    request: {
      datasetId: "ds-1",
      path: "/out/comma-export.parquet",
      format: "parquet",
      spec: { sort: [{ column: "amount", descending: true }], columns: ["id", "amount", "joined"] },
      totalRows: 500,
    },
  });
});

test("export a selection as CSV from the toolbar, then cancel it", async ({ page }) => {
  const box = await open(page, ["/out/some.csv"], 60_000);
  const rowY = (r: number) => 46 + 28 * r + 14;
  // name..amount, rows 2–4.
  await page.mouse.click(box.x + 200, box.y + rowY(1));
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + 340, box.y + rowY(3));
  await page.keyboard.up("Shift");

  await page.getByRole("main").getByRole("button", { name: "Export" }).click();
  await dialog(page).getByRole("radio", { name: "CSV", exact: true }).click();
  await dialog(page)
    .getByRole("radio", { name: /The selection: 3 rows, 2 columns/ })
    .check();
  await dialog(page).getByLabel("Delimiter").selectOption(";");
  await dialog(page).getByRole("button", { name: "Export 3 rows…" }).click();
  await expect(status(page)).toHaveText(/Exporting some\.csv…/);
  const [call] = await invokes(page, "export_view");
  expect(call).toMatchObject({
    request: {
      format: "csv",
      spec: { columns: ["name", "amount"] },
      options: { delimiter: ";", header: true, rows: [[1, 4]] },
      totalRows: 3,
    },
  });
  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(status(page)).toHaveText("Export cancelled");
  expect(await invokes(page, "cancel_export")).toEqual([{ jobId: call!.jobId }]);
});
