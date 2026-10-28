import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

/** WCAG 2.2 A and AA rules. */
async function violations(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return result.violations.map(
    (v) =>
      `${label}: ${v.id} (${v.impact}) ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map(
          (n) => `    ${n.target.join(" ")} — ${n.failureSummary?.split("\n").slice(1).join(" ")}`,
        )
        .join("\n"),
  );
}

for (const scheme of ["light", "dark"] as const) {
  test(`no WCAG AA violations on the main screens (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mockTauri(page, {
      dialogPaths: ["/data/comma.csv"],
      datasets: { "/data/comma.csv": 1000 },
    });
    await page.goto("/");
    const found: string[] = [];
    await expect(page.getByRole("region", { name: "Getting started" })).toBeVisible();
    found.push(...(await violations(page, "start screen")));

    await page.keyboard.press("Control+o");
    await expect(page.getByRole("tab", { name: /comma\.csv/ })).toBeVisible();
    found.push(...(await violations(page, "file open")));

    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: /Command palette/i })).toBeVisible();
    found.push(...(await violations(page, "command palette")));
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+k");
    await page.keyboard.type("filter name");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Filter name" })).toBeVisible();
    found.push(...(await violations(page, "filter editor")));
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+k");
    await page.keyboard.type("keyboard shortcuts");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    found.push(...(await violations(page, "keyboard shortcuts")));
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+j");
    await expect(page.getByRole("region", { name: /SQL/ }).first()).toBeVisible();
    found.push(...(await violations(page, "SQL panel")));

    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    found.push(...(await violations(page, "settings")));
    await page.keyboard.press("Escape");

    expect(found, found.join("\n")).toEqual([]);
  });
}
