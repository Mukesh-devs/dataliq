import { expect, test, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { gridHeader, mockTauri } from "./tauri-mock";

function buildPage(start: number, count: number): string {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

/** Header titles in display order (Glide's accessible header row). */
async function headers(page: Page): Promise<string[]> {
  const texts = await page
    .getByTestId("data-grid")
    .locator('th[role="columnheader"]')
    .allTextContents();
  return texts.filter((t) => t !== "");
}

async function open(page: Page) {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
    fetchRows: buildPage,
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("status")).toContainText("1,000 rows");
  await expect.poll(() => headers(page)).toEqual(["id", "name", "amount", "joined"]);
  return (await page.getByTestId("data-grid").boundingBox())!;
}

// Default widths: row numbers 52 px, id 90, name 160, amount 110, joined 110.
const NAME_X = 180;
const AMOUNT_X = 340;

test("hide a column from its menu, show it again from the sidebar", async ({ page }) => {
  const box = await open(page);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar).toContainText("4 of 4 shown");
  await page.mouse.click(box.x + NAME_X, box.y + 16, { button: "right" });
  await page.getByRole("menuitem", { name: "Hide column" }).click();
  await expect.poll(() => headers(page)).toEqual(["id", "amount", "joined"]);
  await expect(sidebar).toContainText("3 of 4 shown");
  await expect(sidebar.getByLabel("Show name")).not.toBeChecked();
  await sidebar.getByLabel("Show name").check();
  await expect.poll(() => headers(page)).toEqual(["id", "name", "amount", "joined"]);
  // Hide two from the sidebar, then Show all.
  await sidebar.getByLabel("Show id").uncheck();
  await sidebar.getByLabel("Show joined").uncheck();
  await expect.poll(() => headers(page)).toEqual(["name", "amount"]);
  await sidebar.getByRole("button", { name: "Show all" }).click();
  await expect.poll(() => headers(page)).toEqual(["id", "name", "amount", "joined"]);
});

test("pin, rename and drag columns", async ({ page }) => {
  const box = await open(page);
  // Pin amount: it moves to the front and stays there.
  await page.mouse.click(box.x + AMOUNT_X, box.y + 16, { button: "right" });
  await page.getByRole("menuitem", { name: "Pin to the left" }).click();
  await expect.poll(() => headers(page)).toEqual(["amount", "id", "name", "joined"]);
  await expect(page.getByRole("complementary").getByLabel("Pinned")).toBeVisible();

  // Rename id (now second: x 162–252). Sorting still uses the real name.
  await page.mouse.click(box.x + 200, box.y + 16, { button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const input = page.getByLabel("Display name");
  await input.fill("Order ID");
  await input.press("Enter");
  await expect.poll(() => headers(page)).toEqual(["amount", "Order ID", "name", "joined"]);
  await expect(gridHeader(page, "Order ID")).toBeAttached();

  // Drag "name" (x 252–412) to the end.
  await page.mouse.move(box.x + 300, box.y + 16);
  await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 16, { steps: 5 });
  await page.mouse.move(box.x + 560, box.y + 16, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => headers(page)).toEqual(["amount", "Order ID", "joined", "name"]);

  // Auto-fit runs from the menu without errors.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.mouse.click(box.x + 80, box.y + 16, { button: "right" });
  await page.getByRole("menuitem", { name: "Auto-fit width" }).click();
  expect(errors).toEqual([]);
});
