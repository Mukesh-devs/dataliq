import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

/** nested.json's three records as DuckDB read them (the recorded preview). */
const recorded = (
  JSON.parse(readFileSync(resolve(process.cwd(), "e2e/recordings/backend.json"), "utf8")) as {
    files: Record<string, { preview: string }>;
  }
).files;
const nested = recorded["/data/nested.json"]!.preview;

async function open(page: Page, path = "/data/nested.json") {
  // Read in full (imported), so the structure comes from the engine.
  await mockTauri(page, {
    dialogPaths: [path],
    datasets: { [path]: 3 },
    fetchRows: () => nested,
    views: () => 1,
    recipes: (steps) => ({
      rowCount: 5,
      columns: [
        { name: "id", type: "BIGINT" },
        { name: "user", type: "STRUCT(name VARCHAR)" },
        { name: "tags", type: "VARCHAR[]" },
        { name: "scores", type: "BIGINT" },
      ],
      steps: (steps as unknown[]).map(() => ({ error: null, failed: null, skipped: false })),
    }),
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("tab", { name: new RegExp(path.split("/").pop()!) })).toBeVisible();
}

const card = (page: Page, id: string) => page.locator(`[data-id='${id}']`);

test("JSON files show their records as a graph, and the file's structure", async ({ page }) => {
  await open(page);
  const show = page.getByRole("radiogroup", { name: "Show" });
  await show.getByRole("radio", { name: "Graph" }).click();
  const graph = page.getByRole("group", { name: "Graph of record 1" });
  await expect(graph).toBeVisible();
  await expect(card(page, "$.user")).toContainText('name: "Alice"');
  await expect(card(page, "$.user.address")).toContainText('city: "Berlin"');
  // Next record.
  await page.getByRole("button", { name: "Next record" }).click();
  await expect(card(page, "$.user")).toContainText('name: "Bob"');
  // Click a value: its path and value.
  await card(page, "$.scores").getByRole("button", { name: /\[0\]/ }).click();
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("$.scores[0]");

  await page.getByRole("radio", { name: "Structure" }).click();
  await expect(page.getByRole("group", { name: "Graph of the file's structure" })).toBeVisible();
  await expect(card(page, "$.user")).toContainText("in 67% of records");

  // Kept per tab: the grid and back.
  await show.getByRole("radio", { name: "Grid" }).click();
  await expect(page.getByTestId("data-grid")).toBeVisible();
  await show.getByRole("radio", { name: "Graph" }).click();
  await expect(page.getByRole("region", { name: "Graph view" })).toBeVisible();
});

type Invoke = { cmd: string; args: Record<string, unknown> };
const invokes = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (window as unknown as { __invokes: Invoke[] }).__invokes
        .filter((i) => i.cmd === c)
        .map((i) => i.args),
    cmd,
  );

test("filter by a nested value and unnest an array from the graph", async ({ page }) => {
  await open(page);
  await page
    .getByRole("radiogroup", { name: "Show" })
    .getByRole("radio", { name: "Graph" })
    .click();
  await card(page, "$.user.address").getByRole("button", { name: /city/ }).click();
  const use = page.getByRole("group", { name: "Use this" });
  await use
    .getByRole("button", { name: "Only records where user.address.city = “Berlin”" })
    .click();
  await expect(page.getByRole("toolbar", { name: "Filters" })).toContainText(
    'user.address.city = "Berlin"',
  );
  await expect
    .poll(async () => (await invokes(page, "open_view")).at(-1)?.spec)
    .toMatchObject({
      filters: [{ column: "user", path: ["address", "city"], op: "equals", value: "Berlin" }],
    });

  await card(page, "$.scores")
    .getByRole("button", { name: /^scores/ })
    .click();
  await use.getByRole("button", { name: "Unnest into rows (one row per item)" }).click();
  await expect
    .poll(async () => (await invokes(page, "apply_recipe")).at(-1)?.steps)
    .toEqual([{ op: "unnest", column: "scores" }]);
  await expect(page.getByRole("status").first()).toContainText("Unnested");
});

test("Parquet files with nested columns get the graph view too", async ({ page }) => {
  await mockTauri(page, {
    dialogPaths: ["/data/types.parquet"],
    fetchRows: () => recorded["/data/types.parquet"]!.preview,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await page
    .getByRole("radiogroup", { name: "Show" })
    .getByRole("radio", { name: "Graph" })
    .click();
  await expect(page.getByRole("group", { name: "Graph of record 1" })).toBeVisible();
  // Structs and maps as cards; dates as dates.
  await expect(card(page, "$.c_struct")).toBeVisible();
  await expect(card(page, "$")).toContainText(/c_date: "\d{4}-\d{2}-\d{2}"/);
});

test("other files have no graph view", async ({ page }) => {
  await open(page, "/data/comma.csv");
  await expect(page.getByRole("radio", { name: "Graph" })).toHaveCount(0);
});
