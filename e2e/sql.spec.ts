import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

const ipc = (cols: Parameters<typeof tableFromArrays>[0]) =>
  Buffer.from(tableToIPC(tableFromArrays(cols), "stream")).toString("base64");

function buildPage(start: number, count: number): string {
  return ipc({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
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

async function open(page: Page) {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: () => 500,
    sql: (sql) => {
      if (sql.includes("nope")) {
        return {
          kind: "query",
          message:
            'Binder Error: Referenced column "nope" not found in FROM clause!\n\nLINE 1: SELECT nope FROM comma\n               ^',
        };
      }
      if (sql.startsWith("SELECT DISTINCT")) return ipc({ n: Int32Array.from([1, 2]) });
      // The engine probe at startup and everything else.
      return ipc({ version: ["v1.5.6"], city: ["Paris"] });
    },
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status").first()).toContainText("1,000 rows");
}

const editor = (page: Page) => page.getByRole("textbox", { name: "SQL query" });
const panel = (page: Page) => page.getByRole("region", { name: "SQL panel" });

test("query open files as tables with autocomplete, run with Ctrl+Enter", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("list", { name: "Tables" })).toHaveText(
    /comma\s*current_view/,
  );
  await expect
    .poll(() => invokes(page, "register_table"))
    .toEqual([
      { datasetId: "ds-1", name: "comma" },
      { datasetId: "ds-1", name: "current_view" },
    ]);

  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("SELECT DISTINCT n FROM co");
  // Table names complete.
  await expect(page.locator(".cm-tooltip-autocomplete li[aria-selected='true']")).toContainText(
    "comma",
  );
  // CodeMirror ignores Enter for 75 ms after the list opens (interactionDelay).
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveText("SELECT DISTINCT n FROM comma");
  await page.keyboard.press("Control+Enter");
  await expect(panel(page)).toContainText(/2 rows in/);
  expect((await invokes(page, "sql_result")).at(-1)).toMatchObject({
    sql: "SELECT DISTINCT n FROM comma",
    requestId: expect.stringMatching(/^sql-/) as unknown,
  });

  // Format SQL, from the panel's button.
  await panel(page).getByRole("button", { name: "Format" }).click();
  await expect(editor(page)).toHaveText(/SELECT DISTINCT\s+nFROM\s+comma/);

  // Ctrl+J closes it again; the text is kept.
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(editor(page)).toContainText("comma");
});

test("errors are shown in words and marked in the editor", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+j");
  await editor(page).click();
  await page.keyboard.type("SELECT 1;\nSELECT nope FROM comma");
  await panel(page).getByRole("button", { name: "Run" }).click();
  const alert = panel(page).getByRole("alert");
  await expect(alert).toContainText('Referenced column "nope" not found');
  await expect(alert).not.toContainText("LINE 1");
  await expect(panel(page).getByRole("status")).toHaveText("The query failed");
  // Marked at "nope" on the second line (the second statement).
  await expect(page.locator(".cm-lintRange-error")).toHaveText("nope");
  // Both statements ran, in order: the first for its effect, the last as a result.
  expect((await invokes(page, "run_query")).at(-1)?.sql).toBe("SELECT 1");
  expect((await invokes(page, "sql_result")).at(-1)?.sql).toBe("SELECT nope FROM comma");
});

test("run just the selection, from the command palette", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+j");
  await editor(page).click();
  await page.keyboard.type("SELECT nope FROM comma\nSELECT 42");
  // Select the second line.
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("run sql");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toContainText(/1 row in/);
  expect((await invokes(page, "sql_result")).at(-1)?.sql).toBe("SELECT 42");
});

test("rename a file's table; current_view follows the active view", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+j");
  const tables = panel(page).getByRole("list", { name: "Tables" });
  await tables.getByRole("button", { name: "Rename table comma" }).click();
  const input = page.getByLabel("Table name");
  await input.fill("2024");
  await expect(page.getByRole("alert")).toContainText("letters, digits");
  await input.fill("current_view");
  await expect(page.getByRole("alert")).toContainText("active tab");
  await input.fill("sales");
  await input.press("Enter");
  await expect(tables).toHaveText(/sales\s*current_view/);
  expect(await invokes(page, "unregister_table")).toContainEqual({ name: "comma" });
  expect(await invokes(page, "register_table")).toContainEqual({
    datasetId: "ds-1",
    name: "sales",
  });

  // Sort the grid: current_view now reads the view's rows.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("sort by id desc");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await invokes(page, "register_table")).at(-1))
    .toEqual({ datasetId: "view-1", name: "current_view" });

  // A click on a table types its name.
  await editor(page).click();
  await tables.getByRole("button", { name: "current_view" }).click();
  await expect(editor(page)).toHaveText("current_view");
});

test("open a result in its own tab: filter, sort and query it again", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+j");
  await editor(page).click();
  await page.keyboard.type("SELECT DISTINCT n FROM comma");
  await page.keyboard.press("Control+Enter");
  await expect(panel(page)).toContainText(/2 rows in/);
  await panel(page).getByRole("button", { name: "Open in tab" }).click();
  await expect(page.getByRole("tab", { name: "Result 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("main")).toContainText("SQL result");
  await expect(page.getByRole("contentinfo").getByRole("status")).toContainText(
    "2 rows · SQL result",
  );
  await expect(panel(page).getByRole("button", { name: /Opened in a tab/ })).toBeDisabled();
  // The result is a table too.
  await expect(panel(page).getByRole("list", { name: "Tables" })).toContainText("result_1");
  // The next run doesn't close the tab's rows.
  await editor(page).click();
  await page.keyboard.press("Control+Enter");
  await expect(panel(page).getByRole("button", { name: "Open in tab" })).toBeEnabled();
  expect(await invokes(page, "close_dataset")).not.toContainEqual({ datasetId: "sql-1" });
  // Sorting the result tab opens a view over the result.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("sort by n desc");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await invokes(page, "open_view")).at(-1))
    .toMatchObject({ datasetId: "sql-1", spec: { sort: [{ column: "n", descending: true }] } });
});
