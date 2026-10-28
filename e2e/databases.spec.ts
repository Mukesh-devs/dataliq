import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

type Invoke = { cmd: string; args: Record<string, unknown> };

const database = {
  alias: "shop",
  schema: "main",
  table: "customers",
  tables: [
    { schema: "main", name: "customers", kind: "table", rows: 2 },
    { schema: "main", name: "orders", kind: "table", rows: 12000 },
    { schema: "main", name: "big_orders", kind: "view", rows: null },
    { schema: "archive", name: "orders_2023", kind: "table", rows: 10 },
  ],
};

test("a database file shows one table at a time, picked from its list", async ({ page }) => {
  await mockTauri(page, {
    startupFiles: ["/data/shop.duckdb"],
    folders: {
      "/data/shop.duckdb": {
        like: "/data/types.parquet",
        info: { fileName: "shop.duckdb", format: "duckdb", database },
      },
    },
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: /shop\.duckdb/ })).toBeVisible();
  await expect(page.getByText(/^duckdb ·/i)).toBeVisible();
  await expect(page.getByText(/queried in place/)).toBeVisible();

  const picker = page.getByRole("combobox", { name: "Table" });
  await expect(picker.locator("option")).toHaveText([
    "customers (2 rows)",
    "orders (12,000 rows)",
    "big_orders (view)",
    "archive.orders_2023 (10 rows)",
  ]);
  await expect(page.getByTitle("In SQL: shop.customers")).toBeVisible();

  await picker.selectOption({ label: "archive.orders_2023 (10 rows)" });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __invokes: Invoke[] }).__invokes
          .filter((i) => i.cmd === "open_file")
          .map((i) => i.args.options),
      ),
    )
    .toContainEqual(
      expect.objectContaining({ database: { schema: "archive", table: "orders_2023" } }),
    );
});
