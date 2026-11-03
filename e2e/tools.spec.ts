import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

const ipc = (cols: Parameters<typeof tableFromArrays>[0]) =>
  Buffer.from(tableToIPC(tableFromArrays(cols), "stream")).toString("base64");

function buildPage(start: number, count: number): string {
  return ipc({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${(start + i) % 3}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
  });
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
const toolQueries = async (page: Page) =>
  (await invokes(page, "sql_result")).filter((a) => a.group === "tools").map((a) => String(a.sql));

async function open(page: Page, paths = ["/data/comma.csv"]) {
  await mockTauri(page, {
    dialogPaths: paths,
    datasets: { "/data/comma.csv": 1000, "/data/semicolon.csv": 990 },
    fetchRows: buildPage,
    views: () => 500,
    sql: () => ipc({ name: ["name 0", "name 1"], rows: Int32Array.from([5, 7]) }),
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("contentinfo").getByRole("status")).toContainText("1,000 rows");
}

async function palette(page: Page, text: string) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill(text);
  await page.keyboard.press("Enter");
}

test("group by a column with a count and a sum, as a new tab", async ({ page }) => {
  await open(page);
  await palette(page, "group by");
  const dialog = page.getByRole("dialog", { name: "Group by / pivot" });
  await dialog.getByRole("checkbox", { name: "name" }).check();
  // A row count and the sum of the first number column to start with.
  await expect(dialog.getByLabel("Value 1: column")).toHaveValue("");
  await expect(dialog.getByLabel("Value 2: calculation")).toHaveValue("sum");
  await dialog.getByLabel("Value 2: calculation").selectOption("avg");
  await dialog.getByRole("button", { name: "Group", exact: true }).click();
  await expect(page.getByRole("tab", { name: /comma\.csv by name/ })).toBeVisible();
  const [sql] = await toolQueries(page);
  expect(sql).toContain('SELECT "name", count(*) AS "rows", avg("amount") AS "avg_amount"');
  expect(sql).toContain('GROUP BY "name"');
});

test("a number calculation needs a number column", async ({ page }) => {
  await open(page);
  await palette(page, "group by");
  const dialog = page.getByRole("dialog", { name: "Group by / pivot" });
  await dialog.getByLabel("Value 2: column").selectOption("name");
  await expect(dialog).toContainText("Sum needs a number column");
  await expect(dialog.getByRole("button", { name: "Group", exact: true })).toBeDisabled();
});

test("count a column's values and summarize every column", async ({ page }) => {
  await open(page);
  const box = (await page.getByTestId("data-grid").boundingBox())!;
  // The name column's header (row numbers 52 px, id 90 px).
  await page.mouse.click(box.x + 200, box.y + 16, { button: "right" });
  await page.getByRole("menuitem", { name: "Count values" }).click();
  await expect(page.getByRole("tab", { name: /name counts · comma\.csv/ })).toBeVisible();
  expect((await toolQueries(page))[0]).toContain('GROUP BY "name"');

  await page.getByRole("tab", { name: /^comma\.csv/ }).click();
  await palette(page, "summarize every column");
  await expect(page.getByRole("tab", { name: /Summary · comma\.csv/ })).toBeVisible();
  expect((await toolQueries(page))[1]).toContain("SUMMARIZE SELECT * FROM");
});

test("open a random sample", async ({ page }) => {
  await open(page);
  await palette(page, "open a sample");
  const dialog = page.getByRole("dialog", { name: "Open a sample" });
  await dialog.getByLabel("Rows", { exact: true }).fill("250");
  await dialog.getByRole("button", { name: "Open sample" }).click();
  await expect(page.getByRole("tab", { name: /Sample · comma\.csv/ })).toBeVisible();
  expect((await toolQueries(page))[0]).toContain(
    "USING SAMPLE reservoir(250 ROWS) REPEATABLE (42)",
  );
});

test("append and join two open files", async ({ page }) => {
  await open(page, ["/data/comma.csv", "/data/semicolon.csv"]);
  await page.keyboard.press("Control+o");
  await expect(page.getByRole("tab", { name: /semicolon\.csv/ })).toBeVisible();
  await page.getByRole("tab", { name: /^comma\.csv/ }).click();

  await palette(page, "append tabs");
  const append = page.getByRole("dialog", { name: "Append tabs" });
  await expect(append.getByRole("checkbox", { name: /semicolon\.csv/ })).toBeChecked();
  await append.getByRole("button", { name: "Append", exact: true }).click();
  await expect(page.getByRole("tab", { name: /comma\.csv \+ semicolon\.csv/ })).toBeVisible();
  expect((await toolQueries(page))[0]).toMatch(
    /SELECT 'comma\.csv' AS "source", \* FROM .*\nUNION ALL BY NAME\n/,
  );

  await page.getByRole("tab", { name: /^comma\.csv$/ }).click();
  await palette(page, "join with");
  const join = page.getByRole("dialog", { name: "Join with another tab" });
  // Matched by the column both share, an id.
  await expect(join.getByLabel("Key 1: left column")).toHaveValue("id");
  await expect(join.getByLabel("Key 1: right column")).toHaveValue("id");
  await join.getByRole("radio", { name: /Left rows without a match/ }).check();
  await join.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("tab", { name: /comma\.csv ⋈ semicolon\.csv/ })).toBeVisible();
  expect((await toolQueries(page))[1]).toContain("ANTI JOIN");
});
