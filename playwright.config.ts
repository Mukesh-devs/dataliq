import { defineConfig, devices } from "@playwright/test";

// UI flows run against the production bundle (`vite build` + `vite preview`)
// in Chromium, with Tauri IPC mocked by recorded responses (e2e/tauri-mock.ts).
// Not the dev server: React StrictMode's double mount breaks Glide's
// accessible cell mirror in dev builds (see docs/DECISIONS.md, D15).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Screenshot baselines are rendered on Linux; fonts are bundled so they are stable.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
