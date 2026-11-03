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

async function open(
  page: Page,
  views: (spec: unknown) => number | Promise<number> = () => 500,
  extra: Partial<Parameters<typeof mockTauri>[1]> = {},
) {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views,
    ...extra,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status")).toContainText(" rows ·");
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

  // On a slow runner the grid can still be handling the Shift+click when the
  // shortcut is pressed; press again until the palette opens.
  const input = page.getByRole("combobox", { name: "Search commands" });
  await expect(async () => {
    await page.keyboard.press("Control+Shift+c");
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass();
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

test("the status bar adds up the selected cells", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const box = await open(page);
  // amount (0, 0.5, 1, 1.5) of the first four rows: x 302–412.
  const rowY = (r: number) => 46 + 28 * r + 14;
  await page.mouse.click(box.x + 350, box.y + rowY(0));
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + 350, box.y + rowY(3));
  await page.keyboard.up("Shift");
  const stats = page.getByRole("group", { name: "Selection statistics" });
  await expect(stats).toHaveText(/Count:4\s*Sum:3\s*Average:0\.75\s*Min:0\s*Max:1\.5/);
  // Added up from the loaded rows: no backend call.
  expect(await invokes(page, "selection_stats")).toHaveLength(0);
  await stats.getByRole("button", { name: /Sum/ }).click();
  await expect.poll(() => clipboard(page)).toBe("3");

  // Summarize by column from the cell menu.
  await page.mouse.click(box.x + 350, box.y + rowY(2), { button: "right" });
  await page.getByRole("menuitem", { name: "Summarize selection by column…" }).click();
  const summary = page.getByRole("dialog", { name: "Selection summary" });
  await expect(summary.getByRole("row", { name: /amount/ })).toContainText("4");
  await expect(summary.getByRole("row", { name: /amount/ })).toContainText("0.75");
  await page.keyboard.press("Escape");

  // One cell: nothing to add up.
  await page.mouse.click(box.x + 350, box.y + rowY(5));
  await expect(stats).toBeHidden();
});

test("a big selection is added up by the engine", async ({ page }) => {
  const box = await open(page, () => 500, {
    datasets: { "/data/comma.csv": 50_000 },
    selectionStats: (args) => ({
      rows: 50_000,
      distinctApprox: false,
      columns: (args.columns as string[]).map((column) => ({
        column,
        kind: column === "amount" ? "number" : column === "joined" ? "temporal" : "text",
        values: 50_000,
        empty: 0,
        sum: column === "amount" ? 624987500 : null,
        avg: column === "amount" ? 12499.75 : null,
        min: column === "amount" ? 0 : null,
        max: column === "amount" ? 24999.5 : null,
        minText: null,
        maxText: null,
        distinct: null,
      })),
    }),
  });
  await page.mouse.click(box.x + 350, box.y + 60);
  await page.keyboard.press("Control+a");
  const stats = page.getByRole("group", { name: "Selection statistics" });
  await expect(stats).toContainText("Sum:624,987,500");
  await expect(stats).toContainText("Count:200,000");
  const [call] = await invokes(page, "selection_stats");
  // Every row of the view: no ranges sent.
  expect(call).toMatchObject({ rows: null, distinct: false });
});
