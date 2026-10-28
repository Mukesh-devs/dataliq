import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { gridCell, mockTauri } from "./tauri-mock";

type Step = Record<string, unknown> & { op: string; enabled?: boolean };

/** The steps the backend was last asked to apply, as it does them here. */
let applied: Step[] = [];
const on = (s: Step) => s.enabled !== false;
const renamed = () => applied.some((s) => on(s) && s.op === "rename");
const upper = () => applied.some((s) => on(s) && s.op === "changeCase");

/** The file's rows, or the cleaned ones for a `recipe-` dataset. */
function buildPage(start: number, count: number, datasetId: string): string {
  const cleaned = datasetId.startsWith("recipe-");
  const name = Array.from({ length: count }, (_, i) =>
    cleaned && upper() ? `NAME ${start + i + 1}` : `name ${start + i + 1}`,
  );
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    [cleaned && renamed() ? "full name" : "name"]: name,
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

function recipes(steps: Step[]) {
  applied = steps;
  return {
    rowCount: 990,
    columns: [
      { name: "id", type: "BIGINT" },
      { name: renamed() ? "full name" : "name", type: "VARCHAR" },
      { name: "amount", type: "DOUBLE" },
    ],
    steps: steps.map((s) => ({
      error: s.op === "calculate" ? 'Binder Error: column "nope" not found' : null,
      failed: s.op === "changeType" ? 12 : null,
      skipped: !on(s),
    })),
  };
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

async function headers(page: Page): Promise<string[]> {
  const texts = await page
    .getByTestId("data-grid")
    .locator('th[role="columnheader"]')
    .allTextContents();
  return texts.filter((t) => t !== "");
}

async function open(page: Page) {
  applied = [];
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: () => 42,
    recipes,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("contentinfo").getByRole("status")).toContainText("1,000 rows");
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Cleaning steps" });
const form = (page: Page) => panel(page).getByRole("form", { name: "Add a step" });
const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");

test("clean the file step by step: the grid shows the cleaned rows, undo and redo", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: /^Clean/ }).click();
  await expect(panel(page)).toContainText("No steps yet");

  // Title case, then upper case names.
  await form(page).getByLabel("Step").selectOption("changeCase");
  await form(page).getByLabel("Column").selectOption("name");
  await form(page).getByLabel("Case").selectOption("upper");
  await form(page).getByRole("button", { name: "Add step" }).click();
  await expect(status(page)).toContainText("990 rows · cleaned in 21 ms");
  await expect(gridCell(page, "NAME 1")).toBeAttached();
  expect((await invokes(page, "apply_recipe")).at(-1)).toMatchObject({
    datasetId: "ds-1",
    steps: [{ op: "changeCase", column: "name", case: "upper" }],
  });

  // A rename: the new name in the header, and the step counted on the button.
  await form(page).getByLabel("Step").selectOption("rename");
  await form(page).getByLabel("Column").selectOption("name");
  await form(page).getByLabel("New name").fill("full name");
  await form(page).getByRole("button", { name: "Add step" }).click();
  await expect.poll(() => headers(page)).toEqual(["id", "full name", "amount"]);
  await expect(page.getByRole("button", { name: /^Clean/ })).toContainText("2");

  // Filters work on the cleaned rows.
  await page.keyboard.press("Control+f");
  await page.keyboard.type("x");
  await expect(status(page)).toContainText("42 of");
  expect((await invokes(page, "open_view")).at(-1)).toMatchObject({ datasetId: "recipe-2" });
  await page.keyboard.press("Escape");

  // Undo from the panel, redo with the keyboard.
  await panel(page).getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(() => headers(page)).toEqual(["id", "name", "amount"]);
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => headers(page)).toEqual(["id", "full name", "amount"]);

  // Turn the first step off: names are back to lower case.
  await panel(page).getByRole("checkbox", { name: "Apply step 1" }).uncheck();
  await expect(gridCell(page, "name 1")).toBeAttached();
  await expect(panel(page).getByRole("listitem").first()).toHaveText(/“name” in UPPER CASE/);

  // Remove all: the file itself again.
  await panel(page).getByRole("button", { name: "Remove all steps" }).click();
  await expect(status(page)).toContainText("1,000 rows");
  await expect.poll(() => headers(page)).toEqual(["id", "name", "amount", "joined"]);
});

test("a column's menu starts a step on it; failures are shown on their step", async ({ page }) => {
  await open(page);
  const box = (await page.getByTestId("data-grid").boundingBox())!;
  // The amount column's header (row numbers 52 px, id 90, name 160).
  await page.mouse.click(box.x + 340, box.y + 16, { button: "right" });
  await page.getByRole("menuitem", { name: "Clean column…" }).click();
  await expect(form(page).getByLabel("Column")).toHaveValue("amount");

  await form(page).getByLabel("Step").selectOption("changeType");
  await form(page).getByLabel("To").selectOption("integer");
  await form(page).getByRole("button", { name: "Add step" }).click();
  await expect(panel(page)).toContainText("12 values couldn’t be converted (now empty)");

  await form(page).getByLabel("Step").selectOption("calculate");
  await form(page).getByLabel("New column").fill("x");
  await form(page).getByLabel("Expression (DuckDB SQL)").fill("nope + 1");
  await form(page).getByRole("button", { name: "Add step" }).click();
  await expect(panel(page).getByRole("alert")).toContainText('column "nope" not found');

  // Copy as SQL reads from the cleaned rows' script.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("copy view as sql");
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Copied the view as SQL");
  const reader = String((await invokes(page, "view_sql")).at(-1)!.reader);
  expect(reader).toMatch(/^\(\nWITH base AS \(SELECT \* FROM read_csv/);
  // The script stops before the failing step.
  expect((await invokes(page, "recipe_script")).at(-1)!.steps).toEqual([
    { op: "changeType", column: "amount", to: "integer" },
  ]);
});

test("save a recipe, export it as SQL, and load it onto another file", async ({ page }) => {
  applied = [];
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv", "/data/semicolon.csv", "/out/comma-recipe.json"],
    datasets: { "/data/comma.csv": 1000, "/data/semicolon.csv": 1000 },
    savePaths: ["/out/comma-recipe.sql", "/out/comma-recipe.json"],
    fetchRows: buildPage,
    views: () => 42,
    recipes,
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(status(page)).toContainText("1,000 rows");
  await page.getByRole("button", { name: /^Clean/ }).click();
  await form(page).getByLabel("Column").selectOption("name");
  await form(page).getByRole("button", { name: "Add step" }).click();
  await expect(status(page)).toContainText("cleaned in");
  const bar = panel(page).getByRole("toolbar", { name: "Recipe" });

  // Copy: a script that says what it is, each step under its description.
  await bar.getByRole("button", { name: "Copy SQL" }).click();
  await expect(status(page)).toHaveText("Copied the recipe as SQL");
  const sql = await page.evaluate(() => navigator.clipboard.readText());
  expect(sql).toMatch(/^-- DataLiq recipe for comma\.csv: 1 step\.\n-- Runs as-is in DuckDB/);
  expect((await invokes(page, "recipe_script")).at(-1)).toMatchObject({
    datasetId: "ds-1",
    steps: [{ op: "trim", column: "name" }],
    labels: ["Trim spaces in “name”"],
  });

  await bar.getByRole("button", { name: /Export SQL/ }).click();
  await expect(status(page)).toHaveText("Saved the recipe script to comma-recipe.sql");
  expect((await invokes(page, "plugin:dialog|save")).at(-1)).toMatchObject({
    options: { defaultPath: "comma-recipe.sql" },
  });
  expect((await invokes(page, "save_recipe_script")).at(-1)).toMatchObject({
    path: "/out/comma-recipe.sql",
    script: expect.stringMatching(/^-- DataLiq recipe for comma\.csv/) as unknown,
  });

  await bar.getByRole("button", { name: /Save/ }).click();
  await expect(status(page)).toHaveText("Saved the recipe to comma-recipe.json");
  expect((await invokes(page, "save_recipe")).at(-1)).toMatchObject({
    path: "/out/comma-recipe.json",
    recipe: {
      format: "dataliq-recipe",
      version: 1,
      source: "comma.csv",
      columns: expect.arrayContaining([{ name: "joined", type: expect.any(String) }]) as unknown,
      steps: [{ op: "trim", column: "name" }],
    },
  });

  // Another file, without a joined column: the recipe applies, with a warning.
  await page.keyboard.press("Control+o");
  await expect(page.getByRole("tab", { name: /semicolon\.csv/ })).toBeVisible();
  await expect(status(page)).toContainText("1,000 rows");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("load recipe");
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Loaded 1 step from comma-recipe.json");
  await expect(panel(page).getByRole("listitem")).toHaveText(/Trim spaces in “name”/);
  await expect(panel(page).getByRole("status")).toContainText("no column “joined”");
  // Applied to the second file too (the mock names every file's data ds-1).
  const applies = await invokes(page, "apply_recipe");
  expect(applies).toHaveLength(2);
  expect(applies[1]).toMatchObject({ steps: [{ op: "trim", column: "name" }] });
  // The first file keeps its own recipe.
  await page.getByRole("tab", { name: /comma\.csv/ }).click();
  await expect(page.getByRole("button", { name: /^Clean/ })).toContainText("1");
});
