import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name | ${start + i + 1}`),
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

async function open(page: Page, views: (spec: unknown) => number | Promise<number> = () => 500) {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status")).toContainText("1,000 rows");
  return (await page.getByTestId("data-grid").boundingBox())!;
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test("command palette finds and runs actions (Ctrl+K)", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "Search commands" });
  await expect(input).toBeFocused();
  await input.fill("sort amount desc");
  await expect(page.getByRole("option")).toHaveText([/Sort by amount descending/]);
  await input.press("Enter");
  await expect(page.getByRole("combobox")).toBeHidden();
  await expect
    .poll(async () => (await invokes(page, "open_view")).at(-1)?.spec)
    .toEqual({
      sort: [{ column: "amount", descending: true }],
    });

  // The search box in the tab bar opens it too; Escape closes it.
  await page.getByRole("button", { name: "Search commands" }).click();
  await page.getByRole("combobox").fill("clear sort");
  await expect(page.getByRole("option")).toHaveText([/Clear sort/]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox")).toBeHidden();
});

test("copy a selection as Markdown and JSON (Shift+Ctrl+C)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const box = await open(page);
  // id and name of the first two rows (header 46 px, rows 28 px).
  const rowY = (r: number) => 46 + 28 * r + 14;
  await page.mouse.click(box.x + 120, box.y + rowY(0));
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + 260, box.y + rowY(1));
  await page.keyboard.up("Shift");

  await page.keyboard.press("Control+Shift+c");
  const input = page.getByRole("combobox", { name: "Search commands" });
  await expect(input).toHaveValue("Copy ");
  await input.pressSequentially("markdown");
  await input.press("Enter");
  await expect
    .poll(() => clipboard(page))
    .toBe(
      ["| id | name |", "| ---: | --- |", "| 1 | name \\| 1 |", "| 2 | name \\| 2 |"].join("\n"),
    );
  await expect(page.getByRole("status")).toContainText("Copied 2 rows as Markdown table");

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("copy json");
  await page.keyboard.press("Enter");
  // Until the copy lands the clipboard still holds the Markdown; poll gives
  // up on a throw, so read it as null until it is JSON.
  const json = async () => {
    try {
      return JSON.parse(await clipboard(page)) as unknown;
    } catch {
      return null;
    }
  };
  await expect.poll(json).toEqual([
    { id: 1, name: "name | 1" },
    { id: 2, name: "name | 2" },
  ]);
});

test("copy the view as SQL", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  // Sort, then hide a column and copy.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("sort by id desc");
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: "Sidebar" }).getByLabel("Show joined").uncheck();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("view as sql");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Copied the view as SQL");
  const [args] = await invokes(page, "view_sql");
  expect(args).toMatchObject({
    datasetId: "ds-1",
    spec: { sort: [{ column: "id", descending: true }], columns: ["id", "name", "amount"] },
    reader: "read_csv('/data/comma.csv', compression = 'none', allow_quoted_nulls = false)",
    labels: {},
  });
  expect(await clipboard(page)).toContain("SELECT * FROM read_csv('/data/comma.csv'");
});

test("cancel a running query from the status bar", async ({ page }) => {
  // Views never finish: only Cancel ends them.
  await open(page, () => new Promise<number>(() => {}));
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("sort by name asc");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Sorting…");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("1,000 rows");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeHidden();
  const [view] = await invokes(page, "open_view");
  expect(await invokes(page, "cancel_query")).toEqual([{ requestId: view!.requestId }]);
  // The sort is dropped: no sort chip left.
  await expect(page.getByRole("toolbar", { name: "Filters" })).not.toContainText("name");
});
