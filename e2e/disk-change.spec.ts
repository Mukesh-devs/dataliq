import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

type Invoke = { cmd: string; args: Record<string, unknown> };
const stamp = { path: "/data/sales.csv", size: 100, modifiedMs: 1 };

test("a file changed on disk: reload it keeping the search, or keep the rows as read", async ({
  page,
}) => {
  await mockTauri(page, {
    startupFiles: ["/data/sales.csv"],
    folders: {
      "/data/sales.csv": { like: "/data/comma.csv", info: { fileName: "sales.csv", stamp } },
    },
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: /sales\.csv/ })).toBeVisible();
  await page.getByPlaceholder("Search text columns").fill("Alice");
  await page.keyboard.press("Enter");
  const notice = page.getByRole("alert").filter({ hasText: "changed on disk" });
  await expect(notice).toBeHidden();

  // The file is written again; the window gets focus.
  await page.evaluate((s) => {
    (window as unknown as { __diskStamps: unknown }).__diskStamps = {
      "/data/sales.csv": { ...s, size: 180, modifiedMs: 2 },
    };
    window.dispatchEvent(new Event("focus"));
  }, stamp);
  await expect(notice).toBeVisible();

  // Keep as is: no more notice for this version.
  await notice.getByRole("button", { name: "Keep as is" }).click();
  await expect(notice).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(300);
  await expect(notice).toBeHidden();

  // Written once more: reload reads it again and the search stays.
  await page.evaluate((s) => {
    (window as unknown as { __diskStamps: unknown }).__diskStamps = {
      "/data/sales.csv": { ...s, size: 260, modifiedMs: 3 },
    };
    window.dispatchEvent(new Event("focus"));
  }, stamp);
  await expect(notice).toBeVisible();
  const opensBefore = await page.evaluate(
    () =>
      (window as unknown as { __invokes: Invoke[] }).__invokes.filter((i) => i.cmd === "open_file")
        .length,
  );
  await notice.getByRole("button", { name: "Reload" }).click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __invokes: Invoke[] }).__invokes.filter(
            (i) => i.cmd === "open_file",
          ).length,
      ),
    )
    .toBe(opensBefore + 1);
  await expect(page.getByPlaceholder("Search text columns")).toHaveValue("Alice");
});

test("a file deleted while open is said plainly", async ({ page }) => {
  await mockTauri(page, {
    startupFiles: ["/data/sales.csv"],
    folders: {
      "/data/sales.csv": { like: "/data/comma.csv", info: { fileName: "sales.csv", stamp } },
    },
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: /sales\.csv/ })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __diskStamps: unknown }).__diskStamps = { "/data/sales.csv": null };
    window.dispatchEvent(new Event("focus"));
  });
  const notice = page.getByRole("alert").filter({ hasText: "moved or deleted" });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Reload" })).toHaveCount(0);
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toBeHidden();
});
