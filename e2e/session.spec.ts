import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

type Invoke = { cmd: string; args: Record<string, unknown> };
const invokes = (page: import("@playwright/test").Page, cmd: string) =>
  page.evaluate(
    (c) => (window as unknown as { __invokes: Invoke[] }).__invokes.filter((i) => i.cmd === c),
    cmd,
  );

test("the open tabs and their search come back after a restart", async ({ page }) => {
  await mockTauri(page, { startupFiles: ["/data/comma.csv", "/data/nulls.csv"] });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: /nulls\.csv/ })).toBeVisible();
  await page.getByRole("tab", { name: /comma\.csv/ }).click();
  await page.getByPlaceholder("Search text columns").fill("Alice");
  await page.keyboard.press("Enter");
  // Saved a moment after the change.
  await expect
    .poll(async () => {
      const saves = await invokes(page, "session_save");
      const last = saves.at(-1)?.args.workspace as
        { tabs: { path: string; view?: { search?: string } }[] } | undefined;
      return last?.tabs.map((t) => [t.path, t.view?.search ?? null]);
    })
    .toEqual([
      ["/data/comma.csv", "Alice"],
      ["/data/nulls.csv", null],
    ]);

  // A restart (the window loads again; the files given at startup are open already).
  await page.reload();
  await expect(page.getByRole("tab", { name: /comma\.csv/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /nulls\.csv/ })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: /comma\.csv/ }).click();
  await expect(page.getByPlaceholder("Search text columns")).toHaveValue("Alice");
});

test("after a crash: the tabs come back, it says so, diagnostics can be copied", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockTauri(page, {
    session: {
      unclean: true,
      workspace: {
        format: "dataliq-workspace",
        version: 1,
        tabs: [{ path: "/data/comma.csv", layout: { hidden: ["name"] } }],
        active: 0,
      },
    },
  });
  await page.goto("/");
  const banner = page.getByRole("alert").filter({ hasText: "closed unexpectedly" });
  await expect(banner).toBeVisible();
  await expect(page.getByRole("tab", { name: /comma\.csv/ })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(/Reopened 1 file|rows/);
  await expect(page.getByRole("checkbox", { name: "Show name" })).not.toBeChecked();
  await banner.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(page.getByRole("status")).toContainText("Diagnostics copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("DuckDB: v1.5.0");
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
});

test("turning off “Reopen the last session’s files” starts empty", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "dataliq.settings",
      JSON.stringify({ state: { restoreSession: false }, version: 0 }),
    ),
  );
  await mockTauri(page, {
    session: { workspace: { tabs: [{ path: "/data/comma.csv" }], active: 0 } },
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Open file/ }).first()).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
});
