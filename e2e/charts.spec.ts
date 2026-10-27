import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
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

/** Answers like the backend would, by chart type. */
function charts(chart: Record<string, unknown>) {
  const kind = chart.kind as string;
  if (kind === "histogram") {
    return {
      kind,
      xKind: "number",
      x: [],
      series: [],
      bins: [
        { lo: 0, hi: 50, count: 120 },
        { lo: 50, hi: 100, count: 380 },
      ],
      total: 500,
      truncated: false,
      elapsedMs: 4,
    };
  }
  if (kind === "line") {
    return {
      kind,
      xKind: "time",
      x: [Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 1)],
      series: [{ name: "Count", values: [10, 30, 20] }],
      bins: [],
      total: 3,
      truncated: false,
      elapsedMs: 6,
    };
  }
  return {
    kind,
    xKind: "category",
    x: ["Paris", "Berlin", "Tokyo"],
    series: [{ name: "Count", values: [500, 400, 300] }],
    bins: [],
    total: 12,
    truncated: true,
    elapsedMs: 7,
  };
}

async function open(page: Page) {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: () => 42,
    charts,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("contentinfo").getByRole("status")).toContainText("1,000 rows");
}

const panel = (page: Page) => page.getByRole("region", { name: "Chart panel" });
const status = (page: Page) => panel(page).getByRole("status", { name: "Chart status" });

/** Pixels of the chart canvas close to `rgb`. */
function countColor(page: Page, rgb: [number, number, number]) {
  return page.evaluate((target) => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='chart'] canvas");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i]! - target[0]) < 6 &&
        Math.abs(data[i + 1]! - target[1]) < 6 &&
        Math.abs(data[i + 2]! - target[2]) < 6
      )
        n++;
    }
    return n;
  }, rgb);
}

test("chart the view: types, columns, the view's search, a table, kept per tab", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("radiogroup", { name: "Show" })
    .getByRole("radio", { name: "Chart" })
    .click();
  // Dates first: count by month.
  await expect(status(page)).toHaveText("3 points · 6 ms");
  expect((await invokes(page, "chart_data")).at(-1)).toMatchObject({
    datasetId: "ds-1",
    chart: { kind: "line", x: "joined", bucket: "month", measures: [{ agg: "count" }] },
    group: expect.stringMatching(/^chart:/) as unknown,
  });
  await expect(page.getByRole("img", { name: "Line of joined" })).toBeVisible();

  // Bars of names, with a second measure.
  await panel(page).getByRole("radio", { name: "Bar", exact: true }).click();
  await panel(page).getByLabel("Column").selectOption("name");
  await expect(status(page)).toHaveText("Top 3 of 12 groups · 7 ms");
  await panel(page).getByRole("button", { name: "Add measure" }).click();
  await expect
    .poll(async () => (await invokes(page, "chart_data")).at(-1)?.chart)
    .toMatchObject({
      kind: "bar",
      x: "name",
      measures: [{ agg: "count" }, { agg: "sum", column: "id" }],
    });

  // The chart follows the view's search.
  await page.keyboard.press("Control+f");
  await page.keyboard.type("smith");
  await expect
    .poll(async () => (await invokes(page, "chart_data")).at(-1)?.spec)
    .toEqual({ search: "smith" });

  // Its values as a table.
  await panel(page)
    .getByRole("button", { name: /as a table/ })
    .click();
  const table = page.getByRole("table", { name: "Chart values" });
  await expect(table).toContainText("Paris");
  await expect(table.getByRole("row")).toHaveCount(4);
  await panel(page).getByRole("button", { name: "Show the chart" }).click();

  // A histogram needs a number column.
  await panel(page).getByRole("radio", { name: "Histogram" }).click();
  await expect(panel(page).getByLabel("Column")).toHaveValue("id");
  await expect(status(page)).toHaveText("500 values · 4 ms");

  // Back to the grid and to the chart again: the chart is kept.
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Grid" }).click();
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("show a chart");
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("radio", { name: "Histogram" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("charts follow the theme", async ({ page }) => {
  await open(page);
  await page
    .getByRole("radiogroup", { name: "Show" })
    .getByRole("radio", { name: "Chart" })
    .click();
  await panel(page).getByRole("radio", { name: "Bar", exact: true }).click();
  await expect(status(page)).toContainText("Top 3 of 12 groups");
  // --series-1: light #2a78d6, dark #3987e5.
  await expect.poll(() => countColor(page, [0x2a, 0x78, 0xd6])).toBeGreaterThan(500);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("theme: dark");
  await page.keyboard.press("Enter");
  await expect.poll(() => countColor(page, [0x39, 0x87, 0xe5])).toBeGreaterThan(500);
  expect(await countColor(page, [0x2a, 0x78, 0xd6])).toBeLessThan(50);
});
