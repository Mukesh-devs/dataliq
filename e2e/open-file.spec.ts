import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

test("open a CSV from the dialog and see the preview", async ({ page }) => {
  await mockTauri(page, { dialogPaths: ["/data/semicolon.csv"] });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("DuckDB v");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("tab", { name: "semicolon.csv" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("columnheader", { name: "city" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "München" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("3 preview rows");
});

test("import settings show detected values and re-open with overrides", async ({ page }) => {
  await mockTauri(page, { dialogPaths: ["/data/semicolon.csv"] });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await page.getByRole("button", { name: "Import settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Detected: ;");
  await dialog.getByLabel("Encoding").selectOption("latin-1");
  await dialog.getByLabel("Ignore bad rows").check();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toBeHidden();
  const lastOpen = await page.evaluate(() =>
    (window as unknown as { __invokes: { cmd: string; args: { options: unknown } }[] }).__invokes
      .filter((i) => i.cmd === "open_file")
      .at(-1),
  );
  expect(lastOpen?.args.options).toEqual({ csv: { encoding: "latin-1", ignoreErrors: true } });
});

test("errors are shown in plain words", async ({ page }) => {
  await mockTauri(page, { dialogPaths: ["/data/missing.csv"] });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(page.getByRole("alert")).toContainText("File not found: /data/missing.csv");
});
