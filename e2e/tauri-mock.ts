import type { Page } from "@playwright/test";
import { tableFromIPC } from "apache-arrow";
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
  views?: (spec: unknown) => number | Promise<number>;
  /** Value list for `column_values`; runs in Node. */
  values?: (column: string, search: string | null) => { value: string | null; count: number }[];
  /**
   * Result of `run_query` as Arrow IPC (base64), or an error to throw
   * ({ kind, message }); runs in Node. Default: the recorded version query.
   */
  sql?: (sql: string) => string | { kind: string; message: string };
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
  /** Paths returned by successive "Save" dialogs (null = cancelled). */
  savePaths?: (string | null)[];
  /** How long `export_view` runs, emitting 50% halfway (default 0). */
  exportMs?: number;
  /** Result of `chart_data`; runs in Node. Default: three bars. */
  charts?: (chart: Record<string, unknown>, spec: unknown) => unknown;
  /**
   * Result of `apply_recipe` without its dataset (columns, rowCount, steps);
   * runs in Node. The dataset is `recipe-N`, paged through `fetchRows`.
   */
  recipes?: (steps: { op: string; enabled?: boolean }[]) => unknown;
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
  if (options.sql) {
    const sql = options.sql;
    // Rows are counted here, where Arrow is available.
    await page.exposeFunction("__sql", (text: string) => {
      const out = sql(text);
      return typeof out === "string"
        ? { ipc: out, rows: tableFromIPC(Buffer.from(out, "base64")).numRows }
        : out;
    });
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
  if (options.charts) {
    const charts = options.charts;
    await page.exposeFunction("__charts", (chart: Record<string, unknown>, spec: unknown) =>
      charts(chart, spec),
    );
  }
  if (options.recipes) {
    const recipes = options.recipes;
    await page.exposeFunction("__recipes", (steps: { op: string }[]) => recipes(steps));
  }
  await page.addInitScript(
    ({ recordings, dialogPaths, datasets, imports, startupFiles, savePaths, exportMs }) => {
      const toBuffer = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const log: { cmd: string; args: unknown }[] = [];
      const w = window as unknown as Record<string, unknown>;
      w.__invokes = log;
      let nextCallback = 1;
      let nextView = 1;
      let nextResult = 1;
      let nextRecipe = 1;
      // The SQL panel's history and saved queries (kept for the page's life).
      const history: { sql: string; ranAt: number }[] = [];
      const saved: { name: string; sql: string; savedAt: number }[] = [];
      // SQL results by dataset id (Arrow IPC, base64).
      const sqlResults: Record<string, string> = {};
      // Running exports by job id: cancel_export ends them.
      const exportJobs: Record<string, () => void> = {};
      type SqlAnswer = (
        s: string,
      ) => Promise<{ ipc: string; rows: number } | { kind: string; message: string }>;
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
            case "run_query": {
              const sql = w.__sql as SqlAnswer | undefined;
              if (!sql) return toBuffer(recordings.version);
              const out = await sql(String(args.sql));
              if (!("ipc" in out)) throw out;
              return toBuffer(out.ipc);
            }
            case "sql_result": {
              const out = await (w.__sql as SqlAnswer)(String(args.sql));
              if (!("ipc" in out)) throw out;
              const id = `sql-${nextResult++}`;
              sqlResults[id] = out.ipc;
              return { id, rowCount: out.rows, cached: true };
            }
            case "register_table":
            case "unregister_table":
              return null;
            case "add_sql_history": {
              const entry = args.entry as { sql: string };
              const i = history.findIndex((h) => h.sql === entry.sql);
              if (i >= 0) history.splice(i, 1);
              history.unshift({ ...entry, ranAt: Date.now() });
              return history[0];
            }
            case "sql_history": {
              const q = String(args.search ?? "").toLowerCase();
              return history.filter((h) => h.sql.toLowerCase().includes(q));
            }
            case "clear_sql_history":
              history.length = 0;
              return null;
            case "saved_queries":
              return [...saved].sort((a, b) => a.name.localeCompare(b.name));
            case "save_query": {
              const name = String(args.name).trim();
              const i = saved.findIndex((q) => q.name.toLowerCase() === name.toLowerCase());
              if (i >= 0) saved.splice(i, 1);
              const q = { name, sql: String(args.sql), savedAt: Date.now() };
              saved.push(q);
              return q;
            }
            case "delete_saved_query": {
              const i = saved.findIndex((q) => q.name === args.name);
              if (i >= 0) saved.splice(i, 1);
              return i >= 0;
            }
            case "chart_data": {
              const charts = w.__charts as
                ((c: unknown, s: unknown) => Promise<unknown>) | undefined;
              if (charts) return charts(args.chart, args.spec);
              return {
                kind: (args.chart as { kind: string }).kind,
                xKind: "category",
                x: ["a", "b", "c"],
                series: [{ name: "Count", values: [3, 2, 1] }],
                bins: [],
                total: 3,
                truncated: false,
                elapsedMs: 5,
              };
            }
            case "apply_recipe": {
              const recipes = w.__recipes as
                | ((s: unknown) => Promise<{ rowCount: number } & Record<string, unknown>>)
                | undefined;
              if (!recipes) throw { kind: "internal", message: "unmocked command apply_recipe" };
              const { rowCount, ...rest } = await recipes(args.steps);
              const id = `recipe-${nextRecipe++}`;
              return { dataset: { id, rowCount, cached: true }, elapsedMs: 21, ...rest };
            }
            // A saved recipe can be loaded again (in another tab) for the page's life.
            case "save_recipe":
              w.__savedRecipe = args.recipe;
              return null;
            case "load_recipe":
              if (!w.__savedRecipe) throw { kind: "io", message: "No such file" };
              return w.__savedRecipe;
            case "save_recipe_script":
              return null;
            case "recipe_script":
              return `WITH base AS (SELECT * FROM ${String(args.reader)}),\nstep_1 AS (SELECT * FROM base)\nSELECT * FROM step_1;`;
            case "chart_sql":
              return `SELECT city, count(*) AS "Count" FROM ${String(args.reader)} GROUP BY 1`;
            case "save_chart_image":
              return null;
            case "plugin:dialog|save":
              return savePaths.length > 0 ? savePaths.shift() : null;
            case "export_view": {
              const request = args.request as { path: string; totalRows?: number };
              const jobId = String(args.jobId);
              const cancelled = await new Promise<boolean>((done) => {
                exportJobs[jobId] = () => done(true);
                setTimeout(() => {
                  emit("export-progress", { jobId, percent: 50, elapsedMs: exportMs / 2 });
                }, exportMs / 2);
                setTimeout(() => done(false), exportMs);
              });
              delete exportJobs[jobId];
              if (cancelled) throw { kind: "cancelled", message: "Cancelled" };
              return {
                path: request.path,
                rows: request.totalRows ?? 0,
                sheets: 0,
                rowsLeftOut: 0,
                elapsedMs: exportMs,
              };
            }
            case "cancel_export": {
              const end = exportJobs[String(args.jobId)];
              end?.();
              return !!end;
            }
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
            case "cancel_query":
              return true;
            case "view_sql":
              return `-- the view as SQL\nSELECT * FROM ${String(args.reader)};`;
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
              const stored = sqlResults[String(args.datasetId)];
              if (stored) return toBuffer(stored);
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
      savePaths: options.savePaths ?? [],
      exportMs: options.exportMs ?? 0,
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
