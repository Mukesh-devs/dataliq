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

async function open(page: Page) {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
    views: () => 1,
    profile: (column) => ({
      column,
      type: "DOUBLE",
      kind: "number",
      rows: 1000,
      nulls: 0,
      distinct: 1000,
      distinctApprox: false,
      min: "0.0",
      max: "499.5",
      mean: 249.75,
      stddev: 144.4,
      histogram: [],
      top: [],
      topTruncated: false,
      elapsedMs: 3,
    }),
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status").first()).toContainText("1,000 rows");
  return (await page.getByTestId("data-grid").boundingBox())!;
}

// Header 46 px (with histograms), rows 28 px; name column at x 142–302.
const cellPoint = (box: { x: number; y: number }, row: number) => ({
  x: box.x + 200,
  y: box.y + 46 + 28 * row + 14,
});

test("panel toggles in the top right show and hide the sidebar, SQL and profile", async ({
  page,
}) => {
  await open(page);
  const panels = page.getByRole("group", { name: "Panels" });
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar).toBeVisible();
  await panels.getByRole("button", { name: /Hide sidebar/ }).click();
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeVisible();

  await panels.getByRole("button", { name: /Show SQL panel/ }).click();
  await expect(page.getByRole("region", { name: "SQL panel" })).toBeVisible();
  await panels.getByRole("button", { name: /Hide SQL panel/ }).click();
  await expect(page.getByRole("region", { name: "SQL panel" })).toBeHidden();

  // The right panel asks for a column first.
  await panels.getByRole("button", { name: /Show column profile/ }).click();
  const picker = page.getByRole("complementary", { name: "Column profile" });
  await picker.getByRole("button", { name: "amount" }).click();
  await expect(page.getByRole("complementary", { name: "Profile of amount" })).toContainText(
    "249.75",
  );
  await panels.getByRole("button", { name: /Hide column profile/ }).click();
  await expect(page.getByRole("complementary", { name: "Profile of amount" })).toBeHidden();
  // Shown again with the same column.
  await page.keyboard.press("Control+Alt+b");
  await expect(page.getByRole("complementary", { name: "Profile of amount" })).toBeVisible();
});

test("right-click a cell: copy with headers, filter by its value, reload", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const box = await open(page);
  const p = cellPoint(box, 1);
  await page.mouse.click(p.x, p.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Cell" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Copy with headers" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("name\nname 2");

  await page.mouse.click(p.x, p.y, { button: "right" });
  await menu.getByRole("menuitem", { name: /Only rows where name = name 2/ }).click();
  await expect
    .poll(async () => (await invokes(page, "open_view")).at(-1)?.spec)
    .toEqual({ filters: [{ column: "name", op: "equals", value: "name 2" }] });

  // Reload keeps the filter: the file is opened again, then the view.
  const opens = (await invokes(page, "open_file")).length;
  await page.mouse.click(p.x, p.y - 28, { button: "right" });
  await menu.getByRole("menuitem", { name: "Reload file" }).click();
  await expect.poll(async () => (await invokes(page, "open_file")).length).toBe(opens + 1);
  await expect
    .poll(async () => (await invokes(page, "open_view")).at(-1)?.spec)
    .toEqual({ filters: [{ column: "name", op: "equals", value: "name 2" }] });
});

test("the webview's own context menu is off outside text fields", async ({ page }) => {
  await open(page);
  const prevented = (selector: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    }, selector);
  expect(await prevented("[role='tablist']")).toBe(true);
  expect(await prevented("input[aria-label='Search text columns']")).toBe(false);
});

test("the grid follows a theme change at once", async ({ page }) => {
  const box = await open(page);
  // The colour of an empty cell area, right of the last column.
  const pixel = () =>
    page.evaluate(
      ({ x, y }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          "[data-testid='data-grid'] canvas",
        )!;
        const r = canvas.getBoundingClientRect();
        const scale = canvas.width / r.width;
        const d = canvas
          .getContext("2d")!
          .getImageData((x - r.x) * scale, (y - r.y) * scale, 1, 1).data;
        return d[0]! + d[1]! + d[2]!;
      },
      { x: box.x + box.width - 20, y: box.y + 200 },
    );
  const light = await pixel();
  expect(light).toBeGreaterThan(600);
  // System → light → dark.
  const theme = page.getByRole("button", { name: /^Theme:/ });
  await theme.click();
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(pixel).toBeLessThan(200);
});
