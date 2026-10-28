import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

type Invoke = { cmd: string; args: Record<string, unknown> };

const url = "https://example.com/data/people.csv?token=abc";

test("open a file from a URL, with S3 settings in the keychain", async ({ page }) => {
  await mockTauri(page, {
    folders: { [url]: { like: "/data/comma.csv", info: { fileName: "people.csv" } } },
  });
  await page.goto("/");

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("open url");
  await page.keyboard.press("Enter");
  const box = page.getByRole("dialog", { name: "Open URL" });
  const input = box.getByLabel("Open a file from the web or S3");
  await input.fill("example.com/people.csv");
  await expect(box.getByRole("alert")).toHaveText(/Start with https:\/\//);
  await expect(box.getByRole("button", { name: "Open URL" })).toBeDisabled();
  await input.fill(url);
  await box.getByRole("button", { name: "Open URL" }).click();
  // Named after the file, not the query; the header says it's remote.
  await expect(page.getByRole("tab", { name: /^people\.csv/ })).toBeVisible();
  await expect(page.getByText(/csv · remote/i)).toBeVisible();
  const opened = await page.evaluate(() =>
    (window as unknown as { __invokes: Invoke[] }).__invokes
      .filter((i) => i.cmd === "open_file")
      .map((i) => i.args.path),
  );
  expect(opened).toEqual([url]);

  // S3 settings: saved, shown again without the secret, kept when left empty.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("s3 settings");
  await page.keyboard.press("Enter");
  const s3 = page.getByRole("dialog", { name: "Open URL" });
  await expect(s3.getByRole("button", { name: "Save S3 settings" })).toBeDisabled();
  await s3.getByLabel("Access key ID").fill("AKIA123");
  await s3.getByLabel("Secret key").fill("s3cr3t");
  await s3.getByLabel("Endpoint", { exact: true }).fill("minio.local:9000");
  await s3.getByLabel("URL style").selectOption("path");
  await s3.getByLabel("Use HTTPS to the endpoint").uncheck();
  await s3.getByRole("button", { name: "Save S3 settings" }).click();
  await expect(s3.getByRole("status")).toHaveText("S3 settings saved.");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("s3 settings");
  await page.keyboard.press("Enter");
  await expect(s3.getByLabel("Access key ID")).toHaveValue("AKIA123");
  await expect(s3.getByLabel("Secret key")).toHaveValue("");
  await expect(s3.getByLabel("Secret key")).toHaveAttribute("placeholder", /Stored/);
  await expect(s3.getByLabel("Use HTTPS to the endpoint")).not.toBeChecked();
  await s3.getByLabel("Region").fill("eu-west-1");
  await s3.getByRole("button", { name: "Save S3 settings" }).click();
  await expect(s3.getByRole("status")).toHaveText("S3 settings saved.");
  const saved = await page.evaluate(() =>
    (window as unknown as { __invokes: Invoke[] }).__invokes
      .filter((i) => i.cmd === "save_s3_settings")
      .map((i) => i.args.settings),
  );
  expect(saved.at(-1)).toMatchObject({
    keyId: "AKIA123",
    secret: "",
    region: "eu-west-1",
    endpoint: "minio.local:9000",
    urlStyle: "path",
    useSsl: false,
  });
  expect(await page.evaluate(() => (window as unknown as { __s3: object }).__s3)).toMatchObject({
    secret: "s3cr3t",
  });

  await s3.getByRole("button", { name: "Remove" }).click();
  await expect(s3.getByRole("status")).toHaveText("S3 settings removed.");
  await expect(s3.getByLabel("Access key ID")).toHaveValue("");
});
