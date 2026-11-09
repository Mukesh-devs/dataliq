import { expect, test } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { mockTauri } from "./tauri-mock";

/** A file with 2,000 number columns. */
const WIDTH = 2000;
const names = Array.from({ length: WIDTH }, (_, i) => `m${i}`);

function page(start: number, count: number): string {
  const cols: Record<string, Float64Array> = {};
  for (const n of names) cols[n] = Float64Array.from({ length: count }, (_, i) => start + i);
  return Buffer.from(tableToIPC(tableFromArrays(cols), "stream")).toString("base64");
}

test("a 2,000-column file: the sidebar lists only rows in view, charts only columns in view", async ({
  page: p,
}) => {
  const asked: string[][] = [];
  await mockTauri(p, {
    dialogPaths: ["/data/wide.csv"],
    folders: {
      "/data/wide.csv": {
        like: "/data/comma.csv",
        info: {
          fileName: "wide.csv",
          columns: names.map((name) => ({ name, type: "DOUBLE" })),
        },
        preview: page(0, 20),
      },
    },
    datasets: { "/data/wide.csv": 20 },
    fetchRows: page,
    histograms: (columns) => {
      asked.push(columns);
      return columns.map((column) => ({
        column,
        bins: [{ label: "0", from: 0, to: 1, count: 1 }],
      }));
    },
  });
  await p.goto("/");
  await p
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(p.getByRole("status")).toContainText("20 rows");

  const list = p.getByRole("list", { name: "Columns" });
  await expect(list.getByRole("checkbox", { name: "Show m0" })).toBeVisible();
  expect(await list.getByRole("listitem").count()).toBeLessThan(80);
  // Finding a column far down still works.
  await p.getByLabel("Find columns").fill("m1999");
  await expect(list.getByRole("checkbox", { name: "Show m1999" })).toBeVisible();

  // Header charts were asked for the columns on screen, not all 2,000.
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  const total = new Set(asked.flat()).size;
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThan(100);
});
