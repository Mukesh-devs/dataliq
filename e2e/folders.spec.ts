import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

const files = {
  names: ["2024-01.csv", "2024-02.csv", "2024-03.csv.gz"],
  count: 3,
  skipped: 1,
  column: "filename",
};

type Invoke = { cmd: string; args: Record<string, unknown> };

test("open a folder or a pattern of files as one table", async ({ page }) => {
  await mockTauri(page, {
    dialogPaths: ["/data/sales"],
    folders: {
      "/data/sales": { like: "/data/comma.csv", info: { fileName: "sales", files } },
      "/data/logs/*.csv": {
        like: "/data/comma.csv",
        info: { fileName: "logs/*.csv", files: { ...files, names: ["a.csv"], count: 1 } },
      },
    },
  });
  await page.goto("/");
  // The empty window offers a folder.
  await page.getByRole("button", { name: "Open folder" }).click();
  await expect(page.getByRole("tab", { name: /sales/ })).toBeVisible();
  const opened = await page.evaluate(() =>
    (window as unknown as { __invokes: Invoke[] }).__invokes
      .filter((i) => i.cmd === "plugin:dialog|open")
      .map((i) => i.args),
  );
  expect(opened.at(-1)).toMatchObject({ options: { directory: true } });
  // The header says how many files, and names them on hover.
  const badge = page.getByText(/csv · 3 files/i);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("title", /2024-01\.csv\n2024-02\.csv\n2024-03\.csv\.gz/);
  await expect(badge).toHaveAttribute("title", /1 other file left out/);

  // A pattern from the palette.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("pattern");
  await page.keyboard.press("Enter");
  const box = page.getByRole("dialog", { name: "Open folder or pattern" });
  await box.getByLabel("Open many files as one table").fill("/data/logs/*.csv");
  await box.getByRole("button", { name: "Open files" }).click();
  await expect(page.getByRole("tab", { name: /\*\.csv/ })).toBeVisible();
  await expect(page.getByText(/csv · 1 file ·/i)).toBeVisible();
});
