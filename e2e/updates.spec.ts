import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

const setUpdate = (page: Page, update: unknown) =>
  page.addInitScript((u) => {
    (window as unknown as { __update: unknown }).__update = u;
  }, update);

const configured = { configured: true, currentVersion: "1.0.0" };
const newer = {
  version: "1.1.0",
  currentVersion: "1.0.0",
  date: "2026-11-02T10:00:00Z",
  notes: "Faster sorting.\nA new chart type.",
};

async function checkFromMenu(page: Page) {
  await page
    .getByRole("menubar", { name: "Menu bar" })
    .getByRole("menuitem", { name: "Help" })
    .click();
  await page.getByRole("menuitem", { name: /Check for updates/ }).click();
  return page.getByRole("dialog", { name: "Updates" });
}

test("a build without an update key says so", async ({ page }) => {
  await mockTauri(page);
  await page.goto("/");
  const dialog = await checkFromMenu(page);
  await expect(dialog).toContainText("can't update itself");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("the latest version, and a failed check with Try again", async ({ page }) => {
  await mockTauri(page);
  await setUpdate(page, { status: configured, error: "Couldn't check for updates: offline" });
  await page.goto("/");
  const dialog = await checkFromMenu(page);
  await expect(dialog.getByRole("alert")).toHaveText("Couldn't check for updates: offline");
  await page.evaluate(() => {
    (window as unknown as { __update: unknown }).__update = {
      status: { configured: true, currentVersion: "1.0.0" },
    };
  });
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toContainText("DataLiq 1.0.0 is the latest version.");
});

test("a newer version found at startup: notes, then install with progress", async ({ page }) => {
  await mockTauri(page);
  await setUpdate(page, { status: configured, info: newer });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Updates" });
  await expect(dialog).toContainText("DataLiq 1.1.0 is available");
  await expect(dialog).toContainText("You have 1.0.0. Released 2026-11-02.");
  await expect(dialog.getByLabel("Release notes")).toContainText("A new chart type.");

  // Later closes it; the next start doesn't ask again the same day.
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: /Try a sample dataset/ })).toBeVisible();
  await expect(dialog).toBeHidden();

  const again = await checkFromMenu(page);
  await again.getByRole("button", { name: "Install and restart" }).click();
  await expect(again.getByRole("progressbar", { name: "Download" })).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await expect(again).toContainText("Downloading… 5.7 MB of 11.4 MB");
  await expect(again.getByRole("button")).toHaveCount(0);
});

test("no startup check when it's turned off in Settings", async ({ page }) => {
  await mockTauri(page);
  await setUpdate(page, { status: configured, info: newer });
  await page.addInitScript(() =>
    localStorage.setItem(
      "dataliq.settings",
      JSON.stringify({ state: { checkUpdates: false }, version: 0 }),
    ),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Try a sample dataset/ })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog", { name: "Updates" })).toBeHidden();
  const calls = await page.evaluate(() =>
    (window as unknown as { __invokes: { cmd: string }[] }).__invokes.filter(
      (i) => i.cmd === "check_update",
    ),
  );
  expect(calls).toHaveLength(0);
});
