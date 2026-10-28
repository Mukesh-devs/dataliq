import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

type Invoke = { cmd: string; args: Record<string, unknown> };

test("save the open tabs as a workspace and open it again", async ({ page }) => {
  await mockTauri(page, {
    startupFiles: ["/data/comma.csv", "/data/nulls.csv"],
    savePaths: ["/work/comma.bigview"],
    dialogPaths: ["/work/comma.bigview"],
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: /nulls\.csv/ })).toBeVisible();

  // Something set on a tab: a search, and SQL text.
  await page.getByRole("tab", { name: /comma\.csv/ }).click();
  await page.getByPlaceholder("Search text columns").fill("Alice");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+j");
  await page.locator(".cm-content").click();
  await page.keyboard.type("SELECT 42 AS answer");

  await page.keyboard.press("Control+s");
  await expect(page.getByText("Workspace saved: comma.bigview")).toBeVisible();
  const saved = await page.evaluate(
    () =>
      (window as unknown as { __invokes: Invoke[] }).__invokes.filter(
        (i) => i.cmd === "save_workspace",
      )[0]!.args,
  );
  expect(saved).toMatchObject({
    path: "/work/comma.bigview",
    workspace: {
      active: 0,
      tabs: [{ path: "/data/comma.csv", view: { search: "Alice" } }, { path: "/data/nulls.csv" }],
      sql: { text: "SELECT 42 AS answer", open: true },
    },
  });

  // Close everything, then open the workspace from the palette.
  await page.keyboard.press("Control+j");
  await page.getByRole("button", { name: "Close comma.csv" }).click();
  await page.getByRole("button", { name: "Close nulls.csv" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("open workspace");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Workspace opened: comma\.bigview \(2 tabs\)/)).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: /comma\.csv/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByPlaceholder("Search text columns")).toHaveValue("Alice");
  await expect(page.locator(".cm-content")).toHaveText("SELECT 42 AS answer");
});
