import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { fileShown, mockTauri } from "./tauri-mock";

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
      topApprox: false,
      elapsedMs: 3,
    }),
  });
  await page.goto("/");
  // The Home page's button (with DataLiq's own title bar, the tab row's + is in main too).
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .last()
    .click();
  await expect(page.getByRole("status").first()).toContainText("1,000 rows");
  await fileShown(page);
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

test("drag the sidebar's and the profile's edges to resize them, for this window only", async ({
  page,
}) => {
  await open(page);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const width = async (el: import("@playwright/test").Locator) => (await el.boundingBox())!.width;
  expect(await width(sidebar)).toBe(240);

  // Drag the sidebar's edge 120 px to the right.
  const edge = page.getByRole("separator", { name: "Resize the sidebar" });
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(await width(sidebar)).toBe(360);

  // Not past the room the grid needs (1280 − 360 px for the grid).
  await page.mouse.move(box.x + 120 + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(1270, box.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(await width(sidebar)).toBe(1280 - 360);
  await expect(page.getByTestId("data-grid")).toBeVisible();

  // Double-click: the default width again. The keyboard moves it too.
  await edge.dblclick();
  expect(await width(sidebar)).toBe(240);
  await edge.focus();
  await page.keyboard.press("ArrowRight");
  expect(await width(sidebar)).toBe(256);

  // The column profile's edge (on its left) works the same way.
  await page.keyboard.press("Control+Alt+b");
  const profile = page.getByRole("complementary", { name: /Column profile|Profile of/ });
  await expect(profile).toBeVisible();
  expect(await width(profile)).toBe(288);
  const pedge = (await page
    .getByRole("separator", { name: "Resize the column profile" })
    .boundingBox())!;
  await page.mouse.move(pedge.x + pedge.width / 2, pedge.y + 200);
  await page.mouse.down();
  await page.mouse.move(pedge.x + pedge.width / 2 - 100, pedge.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(await width(profile)).toBe(388);

  // A new window starts at the default widths.
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  expect(await width(page.getByRole("complementary", { name: "Sidebar" }))).toBe(240);
});

test("DataLiq's own title bar: one row, the tabs below it, the window's buttons at the end", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("dataliq.settings", JSON.stringify({ state: { titleBar: "custom" } })),
  );
  await open(page);
  const bar = page.getByRole("banner");
  // The system's title bar is turned off, and the empty parts move the window.
  await expect
    .poll(async () => (await invokes(page, "plugin:window|set_decorations")).at(-1))
    .toEqual(expect.objectContaining({ value: false }));
  await expect(bar).toHaveAttribute("data-tauri-drag-region", "");
  await expect(bar.getByRole("menubar", { name: "Menu bar" })).toBeVisible();
  await expect(bar.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("tablist", { name: "Open files" })).toBeVisible();
  // The window's name follows the file in front.
  await expect
    .poll(async () => (await invokes(page, "plugin:window|set_title")).at(-1))
    .toEqual(expect.objectContaining({ value: "comma.csv — DataLiq" }));
  // The window's own buttons, at the right end of the row.
  const buttons = bar.getByRole("group", { name: "Window" });
  await buttons.getByRole("button", { name: "Minimize" }).click();
  await buttons.getByRole("button", { name: "Maximize" }).click();
  expect(await invokes(page, "plugin:window|minimize")).toHaveLength(1);
  expect(await invokes(page, "plugin:window|toggle_maximize")).toHaveLength(1);
  const right = (await bar.boundingBox())!;
  const close = (await buttons.getByRole("button", { name: "Close" }).boundingBox())!;
  expect(Math.round(close.x + close.width)).toBe(Math.round(right.x + right.width));
  // Nothing sticks out of the window.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the window itself never scrolls; the status bar's buttons fit in it", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await open(page);
  const fits = await page.evaluate(() => {
    const d = document.documentElement;
    const bar = document.querySelector("footer")!.getBoundingClientRect();
    const buttons = [...document.querySelectorAll("footer button")].map((b) =>
      b.getBoundingClientRect(),
    );
    return {
      scrolls: getComputedStyle(d).overflow !== "hidden" || d.scrollTop !== 0,
      outside: buttons.filter((b) => b.top < bar.top || b.bottom > bar.bottom).length,
    };
  });
  expect(fits).toEqual({ scrolls: false, outside: 0 });
});

test("short of room, the file's toolbar shows icons (names kept), then scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 800 });
  await open(page);
  const clean = page.getByRole("button", { name: /^Clean/ });
  const width = async () => (await clean.boundingBox())!.width;
  expect(await width()).toBeGreaterThan(50);
  await page.setViewportSize({ width: 1024, height: 640 });
  await expect.poll(width).toBeLessThan(40);
  await expect(clean).toHaveAccessibleName(/Clean/);
  // Narrower still: the bar scrolls within itself, the window doesn't.
  await page.setViewportSize({ width: 720, height: 480 });
  const bar = page.locator(".toolbar").first();
  const sizes = await bar.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(720);
  if (sizes[0]! > sizes[1]!) {
    await bar.hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  }
});
