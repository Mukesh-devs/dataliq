import { expect, test } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { gridCell, mockTauri } from "../tauri-mock";

// Grid scroll budget: about 60 fps, no blank pages longer than 100 ms.
// On demand: `pnpm e2e:perf`. Runs in headless Chromium with the backend
// mocked; each page answers after PAGE_MS (the measured 50M-row page time).
const ROWS = 50_000_000;
const PAGE_MS = 7;

function buildPage(start: number, count: number): Promise<string> {
  const table = tableFromArrays({
    id: BigInt64Array.from({ length: count }, (_, i) => BigInt(start + i + 1)),
    name: Array.from({ length: count }, (_, i) => `name ${start + i + 1}`),
    amount: Float64Array.from({ length: count }, (_, i) => (start + i) * 0.5),
    joined: Array.from({ length: count }, () => new Date(Date.UTC(2024, 0, 31))),
  });
  const b64 = Buffer.from(tableToIPC(table, "stream")).toString("base64");
  return new Promise((r) => setTimeout(() => r(b64), PAGE_MS));
}

interface Stats {
  fps: number;
  longFrames: number;
  worstFrameMs: number;
  pageWaitsMs: number[];
}

test("50M rows: scroll frame rate and page wait", async ({ page }) => {
  await mockTauri(page, {
    dialogPaths: ["/data/comma.csv"],
    datasets: { "/data/comma.csv": ROWS },
    fetchRows: buildPage,
  });
  // Time every page request as the frontend sees it (request to rows ready).
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const internals = w.__TAURI_INTERNALS__ as { invoke: (c: string, a?: unknown) => unknown };
    const invoke = internals.invoke;
    const waits: number[] = [];
    w.__pageWaits = waits;
    internals.invoke = async (cmd: string, args?: unknown) => {
      const t = performance.now();
      const out = await invoke(cmd, args);
      if (cmd === "fetch_rows") waits.push(performance.now() - t);
      return out;
    };
  });
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: /Open file/ })
    .click();
  await expect(gridCell(page, "name 1")).toBeAttached();
  const box = (await page.getByTestId("data-grid").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const measure = async (label: string, step: () => Promise<void>, ms: number) => {
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      (w.__pageWaits as number[]).length = 0;
      const frames: number[] = [];
      w.__frames = frames;
      const tick = (t: number) => {
        frames.push(t);
        if (w.__frames === frames) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const end = Date.now() + ms;
    while (Date.now() < end) await step();
    const stats = await page.evaluate((): Stats => {
      const w = window as unknown as Record<string, unknown>;
      const frames = w.__frames as number[];
      w.__frames = null;
      const gaps = frames.slice(1).map((t, i) => t - frames[i]);
      const span = (frames.at(-1)! - frames[0]) / 1000;
      return {
        fps: (frames.length - 1) / span,
        longFrames: gaps.filter((g) => g > 50).length,
        worstFrameMs: Math.max(...gaps),
        pageWaitsMs: [...(w.__pageWaits as number[])].sort((a, b) => a - b),
      };
    });
    const waits = stats.pageWaitsMs;
    const p95 = waits[Math.floor(waits.length * 0.95)] ?? 0;
    console.log(
      `${label}: ${stats.fps.toFixed(1)} fps, worst frame ${stats.worstFrameMs.toFixed(0)} ms, ` +
        `${stats.longFrames} frames > 50 ms, ${waits.length} page loads, ` +
        `page wait p95 ${p95.toFixed(0)} ms / max ${(waits.at(-1) ?? 0).toFixed(0)} ms`,
    );
    return { ...stats, p95 };
  };

  // Steady wheel scrolling (~3 rows per event), the common case.
  const steady = await measure("steady scroll", () => page.mouse.wheel(0, 100), 4000);
  // Fast scrolling (~60 rows per event): crosses a 500-row page every few events.
  const fast = await measure("fast scroll", () => page.mouse.wheel(0, 2000), 4000);
  // Fast flinging: big jumps that land on unloaded pages every time.
  const fling = await measure("fast fling", () => page.mouse.wheel(0, 400_000), 4000);

  expect(steady.fps).toBeGreaterThan(50);
  expect(fast.fps).toBeGreaterThan(50);
  expect(fast.p95).toBeLessThan(100);
  expect(fling.p95).toBeLessThan(100);
});
