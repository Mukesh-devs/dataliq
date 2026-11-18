import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

type Invoke = { cmd: string; args: Record<string, unknown> };

const invokes = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (window as unknown as { __invokes: Invoke[] }).__invokes
        .filter((i) => i.cmd === c)
        .map((i) => i.args),
    cmd,
  );

test("the menu bar runs the app's commands", async ({ page }) => {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": 1000 },
  });
  await page.goto("/");
  const bar = page.getByRole("menubar", { name: "Menu bar" });
  await expect(bar.getByRole("menuitem")).toHaveText(["File", "Edit", "View", "Data", "Help"]);

  // Nothing open: Export is there but disabled; no recent files yet.
  await bar.getByRole("menuitem", { name: "File" }).click();
  await expect(page.getByRole("menuitem", { name: "Export view…" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Open recent" }).click();
  await expect(page.getByRole("menuitem", { name: "No recent files" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // File › Open file… opens a file; then Export works.
  await bar.getByRole("menuitem", { name: "File" }).click();
  await page.getByRole("menuitem", { name: /Open file…/ }).click();
  await expect(page.getByRole("tab", { name: /comma\.csv/ })).toBeVisible();
  await bar.getByRole("menuitem", { name: "File" }).click();
  await expect(page.getByRole("menuitem", { name: /Export view…/ })).toBeEnabled();
  await page.getByRole("menuitem", { name: "Open recent" }).click();
  await expect(page.getByRole("menuitem", { name: "comma.csv" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // View › Theme › Dark.
  await bar.getByRole("menuitem", { name: "View" }).click();
  await page.getByRole("menuitem", { name: "Theme" }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Alt alone moves to the menu bar; arrows and Enter use it.
  await page.getByRole("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Alt");
  await expect(bar.getByRole("menuitem", { name: "File" })).toBeFocused();
  for (const name of ["Edit", "View", "Data", "Help"]) {
    await page.keyboard.press("ArrowRight");
    await expect(bar.getByRole("menuitem", { name })).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help.getByRole("row", { name: /Open file… Ctrl\+O/ })).toBeVisible();
  await expect(help.getByRole("row", { name: /Save workspace Ctrl\+S/ })).toBeVisible();
  await help.getByRole("button", { name: "Close", exact: true }).click();

  expect(await invokes(page, "set_native_menu")).toEqual([]);
});

test("settings apply as they change, in a tab", async ({ page }) => {
  await mockTauri(page, {});
  await page.goto("/");
  await page.keyboard.press("Control+,");
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const box = page.getByRole("region", { name: "Settings" });
  const memory = box.getByLabel("Memory limit (MB)");
  await expect(memory).toHaveAttribute("placeholder", "8192");
  await expect(box.getByText(/half of this computer's 16 GB \(8\.0 GB\)/)).toBeVisible();

  // A value the backend refuses is said in words, under the setting.
  await memory.fill("100");
  await memory.press("Enter");
  await expect(box.getByRole("alert")).toHaveText(/at least 256 MB/);
  await memory.fill("4096");
  await memory.press("Enter");
  await expect(box.getByRole("alert")).toHaveCount(0);

  // Typed values save on Enter or on leaving the box; lists at once.
  await box.getByLabel("Worker threads").fill("4");
  await box.getByLabel("Worker threads").press("Tab");
  await box.getByLabel("Density").selectOption("compact");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await box.getByLabel("Size limit (GB)").fill("50");
  await box.getByLabel("Size limit (GB)").press("Enter");
  await box.getByLabel("Location").fill("/big/disk/cache");
  await box.getByLabel("Location").press("Enter");
  await expect(page.getByRole("status")).toContainText("used when DataLiq restarts");
  await box.getByLabel("Default format").selectOption("parquet");
  await expect
    .poll(async () => (await invokes(page, "save_settings")).at(-1))
    .toEqual({
      settings: {
        memoryLimitMb: 4096,
        tempDir: null,
        threads: 4,
        cacheEnabled: true,
        cacheMaxGb: 50,
        cacheDir: "/big/disk/cache",
        smallFileMb: 0,
      },
    });

  // The search narrows the settings and the list of sections.
  await box.getByRole("searchbox", { name: "Search settings" }).fill("threads");
  await expect(box.getByLabel("Worker threads")).toBeVisible();
  await expect(box.getByLabel("Density")).toBeHidden();
  await expect(box.getByRole("navigation").getByRole("button")).toHaveText(["Memory and speed"]);

  // Closed (Ctrl+W) and opened again: what was saved.
  await page.keyboard.press("Control+w");
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveCount(0);
  await page.keyboard.press("Control+,");
  await expect(memory).toHaveValue("4096");
  await expect(box.getByLabel("Default format")).toHaveValue("parquet");
});
