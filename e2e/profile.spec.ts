import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${(start + i) % 7}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

type Spec = { filters?: { column: string }[] };

/** Invokes of `cmd` so far, with their arguments. */
function invokes(page: Page, cmd: string) {
  return page.evaluate(
    (c) =>
      (
        window as unknown as { __invokes: { cmd: string; args: Record<string, unknown> }[] }
      ).__invokes
        .filter((i) => i.cmd === c)
        .map((i) => i.args),
    cmd,
  );
}

async function open(page: Page) {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: () => 500,
    histograms: (columns) =>
      columns.map((column) => ({
        column,
        kind: "number",
        bins: [1, 4, 9, 16, 9, 4, 1].map((count, i) => ({ lo: i, hi: i + 1, count })),
      })),
    profile: (column, spec) => {
      const filtered = ((spec as Spec).filters?.length ?? 0) > 0;
      const rows = filtered ? 500 : 1000;
      return {
        column,
        type: "DOUBLE",
        kind: "number",
        rows,
        nulls: 0,
        distinct: rows,
        distinctApprox: false,
        min: "0.0",
        max: filtered ? "249.5" : "499.5",
        mean: filtered ? 124.75 : 249.75,
        stddev: 144.4,
        histogram: [
          { lo: 0, hi: 250, count: rows / 2 },
          { lo: 250, hi: 500, count: rows / 2 },
        ],
        top: [{ value: "0.0", count: 1 }],
        topTruncated: true,
        elapsedMs: 42,
      };
    },
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status")).toContainText("1,000 rows");
  return (await page.getByTestId("data-grid").boundingBox())!;
}

// Default widths: row numbers 52 px, id 90, name 160, amount 110.
const AMOUNT_X = 340;

test("header histograms for number columns, hidden from the status bar", async ({ page }) => {
  const box = await open(page);
  await expect.poll(async () => (await invokes(page, "column_histograms")).length).toBe(1);
  const [first] = await invokes(page, "column_histograms");
  // Only columns that can be charted: numbers and dates, not text.
  expect(first!.columns).toEqual(["id", "amount", "joined"]);
  // The headers grow to fit the bars.
  await expect(page).toHaveScreenshot("header-histograms.png", {
    clip: { x: box.x, y: box.y, width: 420, height: 60 },
  });

  const toggle = page.getByRole("button", { name: "Hide column histograms" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(page.getByRole("button", { name: "Show column histograms" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page).toHaveScreenshot("header-plain.png", {
    clip: { x: box.x, y: box.y, width: 420, height: 60 },
  });
});

test("column profile follows the view's filters", async ({ page }) => {
  const box = await open(page);
  await page.mouse.click(box.x + AMOUNT_X, box.y + 16, { button: "right" });
  await page.getByRole("menuitem", { name: "Column profile" }).click();
  const panel = page.getByRole("complementary", { name: "Profile of amount" });
  await expect(panel).toContainText("Mean");
  await expect(panel).toContainText("249.75");
  await expect(panel.getByRole("region", { name: "Histogram" }).getByRole("listitem")).toHaveCount(
    2,
  );
  await expect(panel).toContainText("Showing the 10 most common values");

  // Filter from the same column's menu: the profile is recomputed for the view.
  await page.mouse.click(box.x + AMOUNT_X, box.y + 16, { button: "right" });
  await page.getByRole("menuitem", { name: /Filter/ }).click();
  const editor = page.getByRole("dialog", { name: /Filter amount/ });
  await editor.getByLabel("Value").fill("250");
  await editor.getByRole("button", { name: "Apply" }).click();
  await expect(panel).toContainText("124.75");
  const calls = await invokes(page, "column_profile");
  expect((calls.at(-1)!.spec as Spec).filters).toHaveLength(1);
  // Histograms follow the filter too.
  await expect
    .poll(async () => ((await invokes(page, "column_histograms")).at(-1)!.spec as Spec).filters)
    .toHaveLength(1);

  await panel.getByRole("button", { name: "Close profile" }).click();
  await expect(panel).toBeHidden();
});
