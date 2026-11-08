import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

/** nested.json's three records as DuckDB read them (the recorded preview). */
const nested: string = (
  JSON.parse(readFileSync(resolve(process.cwd(), "e2e/recordings/backend.json"), "utf8")) as {
    files: Record<string, { preview: string }>;
  }
).files["/data/nested.json"]!.preview;

async function open(page: Page, path = "/data/nested.json") {
  // Read in full (imported), so the structure comes from the engine.
  await mockTauri(page, {
    dialogPaths: [path],
    datasets: { [path]: 3 },
    fetchRows: () => nested,
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

test("other files have no graph view", async ({ page }) => {
  await open(page, "/data/comma.csv");
  await expect(page.getByRole("radio", { name: "Graph" })).toHaveCount(0);
});
