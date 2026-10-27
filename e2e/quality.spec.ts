import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => ` name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

const quality = {
  rows: 1000,
  elapsedMs: 31,
  warnings: [
    {
      kind: "spaces",
      column: "name",
      rows: 120,
      message: "120 values have spaces at the start or end",
      filters: [{ column: "name", op: "regex", pattern: "^\\s|\\s$" }],
      fix: { op: "trim", column: "name" },
    },
    {
      kind: "duplicates",
      column: null,
      rows: 4,
      message: "4 rows are exact copies of an earlier row",
      filters: [],
      fix: { op: "removeDuplicates" },
    },
  ],
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

test("quality warnings show their rows, fix them, and list duplicates in SQL", async ({ page }) => {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: () => 120,
    quality,
    recipes: (steps) => ({
      rowCount: 1000,
      columns: [
        { name: "id", type: "BIGINT" },
        { name: "name", type: "VARCHAR" },
        { name: "amount", type: "DOUBLE" },
      ],
      steps: steps.map(() => ({ error: null, failed: null, skipped: false })),
    }),
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  const status = page.getByRole("contentinfo").getByRole("status");
  await expect(status).toContainText("1,000 rows");

  await page.getByRole("button", { name: /^Quality/ }).click();
  const panel = page.getByRole("complementary", { name: "Data quality" });
  await expect(panel.getByRole("status")).toHaveText("2 warnings in 1,000 rows · 31 ms");
  expect((await invokes(page, "data_quality")).at(-1)).toMatchObject({
    datasetId: "ds-1",
    group: expect.stringMatching(/^quality:/) as unknown,
  });
  await expect(page.getByRole("button", { name: /^Quality/ })).toContainText("2");

  // Show rows: the warning's filters on the view.
  await panel.getByRole("button", { name: "Show 120 rows" }).click();
  await expect(status).toContainText("120 of 1,000 rows");
  expect((await invokes(page, "open_view")).at(-1)).toMatchObject({
    spec: { filters: [{ column: "name", op: "regex", pattern: "^\\s|\\s$" }] },
  });

  // Fix: a cleaning step; the check runs again on the cleaned rows.
  await panel.getByRole("button", { name: /Fix: Trim spaces in “name”/ }).click();
  await expect(status).toHaveText(/Added a cleaning step: Trim spaces in “name”/);
  await expect
    .poll(async () => (await invokes(page, "apply_recipe")).at(-1)?.steps)
    .toEqual([{ op: "trim", column: "name" }]);
  await expect
    .poll(async () => (await invokes(page, "data_quality")).at(-1)?.datasetId)
    .toBe("recipe-1");
  await expect(page.getByRole("button", { name: /^Clean/ })).toContainText("1");

  // Duplicates: the query that lists them, in the SQL panel.
  await panel.getByRole("button", { name: "Show copies in SQL" }).click();
  await expect(page.getByRole("region", { name: "SQL" })).toContainText(
    "SELECT *, count(*) AS copies",
  );
});
