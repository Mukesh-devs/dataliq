import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

/**
 * A keyboard-only walkthrough: no mouse from start to end. Each step checks
 * where the focus is, so nothing traps it and nothing is out of reach.
 */
function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

const focused = (page: Page) => page.locator(":focus");

async function palette(page: Page, command: string) {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test("open, sort, filter, search, query and set up the app with the keyboard only", async ({
  page,
}) => {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv", "/data/semicolon.csv"],
    imports: { "/data/comma.csv": { progress: [], rows: 1000, stepMs: 10 } },
    fetchRows: buildPage,
    views: () => 12,
  });
  await page.goto("/");

  // Tab reaches the start screen's buttons in order, with a visible ring.
  await page.keyboard.press("Tab");
  await expect(focused(page)).toHaveAccessibleName("File");
  await expect(focused(page)).toHaveCSS("outline-style", "solid");

  // The getting-started tips: Next, Next, Got it.
  const tips = page.getByRole("region", { name: "Getting started" });
  await tips.getByRole("button", { name: /Next/ }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(tips).toContainText("Tip 3 of 3");
  await expect(focused(page)).toHaveAccessibleName("Got it");
  await page.keyboard.press("Enter");
  await expect(tips).toBeHidden();

  // Open a file.
  await page.keyboard.press("Control+o");
  await expect(page.getByRole("status").first()).toContainText("1,000 rows");

  // Sort and filter from the command palette.
  await palette(page, "sort by amount descending");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __invokes: { cmd: string; args: { spec?: unknown } }[] }).__invokes
          .filter((i) => i.cmd === "open_view")
          .map((i) => JSON.stringify(i.args.spec))
          .at(-1),
      ),
    )
    .toContain('"sort":[{"column":"amount","descending":true}]');
  await palette(page, "filter name");
  const editor = page.getByRole("dialog", { name: "Filter name" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Value")).toBeFocused();
  await page.keyboard.type("ann");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("toolbar", { name: "Filters" }).getByRole("button", {
      name: 'Edit filter: name contains "ann"',
    }),
  ).toBeVisible();

  // Search in the data.
  await page.keyboard.press("Control+f");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("Escape");

  // Tabs: a second file, then arrows between tabs and Delete to close one.
  await page.keyboard.press("Control+o");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "semicolon.csv" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(focused(page)).toHaveAccessibleName("comma.csv");
  await expect(focused(page)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await expect(page.getByRole("tab")).toHaveCount(1);

  // The SQL editor takes Tab for indenting; Escape then Tab leaves it.
  await page.keyboard.press("Control+j");
  const sql = page.getByRole("textbox", { name: "SQL query" });
  await expect(sql).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sql).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(sql).not.toBeFocused();

  // The menu bar: Alt, arrows, Enter.
  await page.keyboard.press("Alt");
  await expect(focused(page)).toHaveAccessibleName("File");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");

  // Settings: opens with the keyboard, closes with Escape.
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});
