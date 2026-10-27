import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// On-demand UI performance checks (`pnpm e2e:perf`), same server as the UI flows.
export default defineConfig({
  ...base,
  testDir: "e2e/perf",
  testMatch: "**/*.perf.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});
