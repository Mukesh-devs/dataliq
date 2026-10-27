import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Real backend responses recorded by src-tauri/tests/ui_recordings.rs. */
const recordings = JSON.parse(
  readFileSync(resolve(process.cwd(), "e2e/recordings/backend.json"), "utf8"),
) as {
  version: string;
  files: Record<string, { info: unknown; preview: string }>;
};

export interface MockOptions {
  /** Paths returned by successive "Open file" dialogs ("a|b" = several files). */
  dialogPaths?: string[];
  /** Give these recorded files a pageable dataset with this many rows. */
  datasets?: Record<string, number>;
  /** Builds Arrow IPC (base64) for `fetch_rows`; runs in Node. */
  fetchRows?: (start: number, count: number, datasetId: string) => string | Promise<string>;
  /** Row count of a view (`open_view`); runs in Node. Throw to fail it. */
  views?: (spec: unknown) => number;
  /** Value list for `column_values`; runs in Node. */
  values?: (column: string, search: string | null) => { value: string | null; count: number }[];
  /** Result of `column_profile`; runs in Node. */
  profile?: (column: string, spec: unknown) => unknown;
  /** Result of `column_histograms` (none by default); runs in Node. */
  histograms?: (columns: string[], spec: unknown) => unknown[];
  /**
   * Simulated background imports by path: progress events to emit (one per
   * `stepMs`) and the final row count. Paths not listed never finish.
   */
  imports?: Record<string, { progress: number[]; rows: number; stepMs?: number }>;
  /** Files the app "was started with" (`bigview <files>`). */
  startupFiles?: string[];
}

/**
 * Installs a fake `window.__TAURI_INTERNALS__` before the app loads, so the
 * frontend runs in a plain browser against recorded backend responses.
 * Every invoke is logged in `window.__invokes` for assertions.
 */
export async function mockTauri(page: Page, options: MockOptions = {}) {
  if (options.fetchRows) {
    const build = options.fetchRows;
    await page.exposeFunction("__fetchRows", (start: number, count: number, id: string) =>
      build(start, count, id),
    );
  }
  if (options.views) {
    const count = options.views;
    await page.exposeFunction("__viewRows", (spec: unknown) => count(spec));
  }
  if (options.values) {
    const values = options.values;
    await page.exposeFunction("__values", (column: string, search: string | null) =>
      values(column, search),
    );
  }
  if (options.profile) {
    const profile = options.profile;
    await page.exposeFunction("__profile", (column: string, spec: unknown) =>
      profile(column, spec),
    );
  }
  if (options.histograms) {
    const histograms = options.histograms;
    await page.exposeFunction("__histograms", (columns: string[], spec: unknown) =>
      histograms(columns, spec),
    );
  }
  await page.addInitScript(
    ({ recordings, dialogPaths, datasets, imports, startupFiles }) => {
      const toBuffer = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const log: { cmd: string; args: unknown }[] = [];
      const w = window as unknown as Record<string, unknown>;
      w.__invokes = log;
      let nextCallback = 1;
      let nextView = 1;
      const listeners: Record<string, number[]> = {};
      const emit = (event: string, payload: unknown) => {
        for (const id of listeners[event] ?? []) {
          (w[`_${id}`] as (e: unknown) => void)?.({ event, id, payload });
        }
      };
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Lets tests deliver backend events, e.g. drag and drop or forwarded files.
      w.__emit = emit;
      w.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        transformCallback: (cb: unknown) => {
          const id = nextCallback++;
          w[`_${id}`] = cb;
          return id;
        },
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          log.push({ cmd, args });
          const file = recordings.files[String(args.path)];
          switch (cmd) {
            case "run_query":
              return toBuffer(recordings.version);
            case "plugin:dialog|open": {
              // The app asks for multiple files; a test may queue a list.
              const next = dialogPaths.shift();
              return next === undefined ? null : next.split("|");
            }
            case "open_file": {
              if (!file) throw { kind: "query", message: `File not found: ${String(args.path)}` };
              const rows = datasets[String(args.path)];
              return rows === undefined
                ? file.info
                : { ...(file.info as object), dataset: { id: "ds-1", rowCount: rows } };
            }
            case "plugin:event|listen": {
              const event = String(args.event);
              (listeners[event] ??= []).push(Number(args.handler));
              return Number(args.handler);
            }
            case "plugin:event|unlisten":
              return null;
            case "take_startup_files":
              return startupFiles.splice(0);
            case "get_settings":
              return { memoryLimitMb: null, cacheEnabled: true, cacheMaxGb: 20, smallFileMb: 0 };
            case "cache_info":
              return {
                dir: "/cache",
                enabled: true,
                maxBytes: 20 * 1024 ** 3,
                usedBytes: 0,
                entries: 0,
              };
            case "cancel_import":
            case "close_dataset":
              return true;
            case "import_file": {
              const plan = imports[String(args.path)];
              if (!plan) return new Promise(() => {}); // never finishes
              for (const percent of plan.progress) {
                await sleep(plan.stepMs ?? 150);
                emit("import-progress", { jobId: args.jobId, percent, elapsedMs: 1000 });
              }
              await sleep(plan.stepMs ?? 150);
              return {
                dataset: { id: "imported-1", rowCount: plan.rows, cached: true },
                fromCache: false,
                elapsedMs: 4200,
              };
            }
            case "fetch_rows": {
              const fetchRows = w.__fetchRows as (
                s: number,
                c: number,
                id: string,
              ) => Promise<string>;
              return toBuffer(
                await fetchRows(Number(args.start), Number(args.count), String(args.datasetId)),
              );
            }
            case "open_view": {
              const viewRows = w.__viewRows as (spec: unknown) => Promise<number>;
              const rowCount = await viewRows(args.spec);
              const id = `view-${nextView++}`;
              // Sorted views finish in the background (the test emits view-ready).
              const sorted = ((args.spec as { sort?: unknown[] }).sort?.length ?? 0) > 0;
              return {
                dataset: { id, rowCount, cached: true },
                totalRows: 1000,
                elapsedMs: 15,
                materializing: sorted,
              };
            }
            case "column_values": {
              const values = w.__values as (c: string, s: string | null) => Promise<unknown[]>;
              const list = await values(String(args.column), (args.search as string) ?? null);
              return { values: list, truncated: false };
            }
            case "column_profile": {
              const profile = w.__profile as (c: string, s: unknown) => Promise<unknown>;
              if (!profile) throw { kind: "internal", message: "unmocked command column_profile" };
              return profile(String(args.column), args.spec);
            }
            case "column_histograms": {
              const histograms = w.__histograms as
                ((c: string[], s: unknown) => Promise<unknown[]>) | undefined;
              return histograms ? histograms(args.columns as string[], args.spec) : [];
            }
            case "preview_file":
              if (!file) throw { kind: "query", message: `File not found: ${String(args.path)}` };
              return toBuffer(file.preview);
            default:
              throw { kind: "internal", message: `unmocked command ${cmd}` };
          }
        },
      };
    },
    {
      recordings,
      dialogPaths: options.dialogPaths ?? [],
      datasets: options.datasets ?? {},
      imports: options.imports ?? {},
      startupFiles: options.startupFiles ?? [],
    },
  );
}

/**
 * A cell in the grid's accessible mirror (Glide renders visible cells as a
 * hidden table inside the canvas, so query it with `toBeAttached`).
 */
export function gridCell(page: Page, text: string) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .getByTestId("data-grid")
    .locator('td[role="gridcell"]')
    .filter({ hasText: new RegExp(`^${escaped}$`) });
}

export function gridHeader(page: Page, text: string) {
  return page
    .getByTestId("data-grid")
    .locator('th[role="columnheader"]')
    .filter({ hasText: new RegExp(`^${text}$`) });
}

/** Delivers a backend event (as Tauri would) to the page's listeners. */
export function emitEvent(page: Page, event: string, payload: unknown) {
  return page.evaluate(
    ([e, p]) => (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(e, p),
    [event, payload] as const,
  );
}
