import type { Table } from "apache-arrow";
import { create } from "zustand";
import {
  baseName,
  cancelImport,
  closeDataset,
  importFile,
  openDirect,
  openFile,
  previewFile,
  type ImportProgress,
  type OpenOptions,
  type DatasetInfo,
  type SourceInfo,
} from "../lib/files";
import { cancelQuery } from "../lib/ipc";
import { describeColumns } from "../lib/arrow";
import type { ChartSpec } from "../lib/chart";
import type { ColumnLayout } from "../lib/layout";
import { isIdentity, openView, type ViewReady, type ViewSpec } from "../lib/view";
import { useRecent } from "./recent";

export type TabStatus = "loading" | "ready" | "error";

export interface ImportState {
  jobId: string;
  status: "running" | "done" | "error" | "cancelled";
  /** 0–100, or null while it can't be estimated. */
  percent: number | null;
  elapsedMs: number;
  /** Error message (status "error"). */
  error?: string;
  /** Error kind from the backend, e.g. "low-disk". */
  errorKind?: string;
  /** Reused an existing cache entry. */
  fromCache?: boolean;
}

/** The tab's view (filters, …) opened as its own dataset. */
export interface ViewState {
  /** "waiting": the full data isn't ready yet (still importing). */
  status: "waiting" | "running" | "done" | "error";
  requestId: string;
  /** The view's rows; kept while a newer view is computed. */
  dataset?: DatasetInfo;
  /** The spec `dataset` was computed for (what is on screen). */
  spec?: ViewSpec;
  /** Rows in the whole file. */
  totalRows?: number;
  /** Time until the view's rows were on screen. */
  elapsedMs?: number;
  /** A sorted view's first and last rows are ready; the rest is still sorting. */
  sorting?: boolean;
  /** Time until the whole view was written (sorted views). */
  fullMs?: number;
  error?: string;
}

export interface Tab {
  id: string;
  /** Display name, usually the file name. */
  title: string;
  /** Absolute path of the opened file. */
  path: string;
  options: OpenOptions;
  status: TabStatus;
  info?: SourceInfo;
  /** First rows read straight from the file. */
  preview?: Table;
  error?: string;
  /** Time from open to first rows on screen, in ms. */
  previewMs?: number;
  /** Background import of the full file. */
  import?: ImportState;
  /** What the user asked to see (filters, …). */
  view?: ViewSpec;
  viewState?: ViewState;
  /** Column order, hidden and pinned columns, names and widths. */
  layout?: ColumnLayout;
  /** Table name chosen for the SQL panel (else one made from the file name). */
  sqlName?: string;
  /** The grid, or a chart of the view. */
  mode?: "grid" | "chart";
  /** The tab's chart (kept while the grid is shown). */
  chart?: ChartSpec;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  setActive: (id: string) => void;
  /** Opens a file in a new tab (or focuses it if already open). */
  openPath: (path: string) => Promise<void>;
  /** Opens several files; the last one becomes active. */
  openPaths: (paths: string[]) => Promise<void>;
  /** Activates the next (+1) or previous (-1) tab, wrapping around. */
  cycle: (step: 1 | -1) => void;
  /** Re-opens a tab's file with new import settings. */
  reopen: (id: string, options: OpenOptions) => Promise<void>;
  /**
   * Reads the file again (e.g. it changed on disk), keeping the tab's
   * filters, sort and column layout. An unchanged file reopens from the cache.
   */
  reload: (id: string) => Promise<void>;
  cancelImport: (id: string) => Promise<void>;
  /** Reads the file directly instead of importing (e.g. low disk space). */
  readDirect: (id: string) => Promise<void>;
  close: (id: string) => void;
  /** Applies an `import-progress` event (subscribed once by the App). */
  applyProgress: (progress: ImportProgress) => void;
  /** Changes a tab's view (filters, …); the grid follows when it is computed. */
  setView: (id: string, view: ViewSpec) => Promise<void>;
  /**
   * Stops the tab's view work: a view still being computed is abandoned
   * (the tab goes back to the rows on screen and their filters); a sort
   * still finishing in the background is dropped (filters and search stay).
   */
  cancelView: (id: string) => void;
  /** Applies a `view-ready` event (subscribed once by the App). */
  applyViewReady: (ready: ViewReady) => void;
  setLayout: (id: string, layout: ColumnLayout) => void;
  /**
   * Opens a SQL result in a new tab (filters, sort, profiles, export as for
   * a file). The tab owns the dataset from then on. Returns the tab id.
   */
  openResult: (result: { dataset: DatasetInfo; preview: Table; sql: string }) => string;
  /** Renames the tab's SQL table; undefined goes back to the file's name. */
  setSqlName: (id: string, name: string | undefined) => void;
  setMode: (id: string, mode: "grid" | "chart") => void;
  setChart: (id: string, chart: ChartSpec) => void;
}

let nextId = 1;
let nextJob = 1;
let nextView = 1;
let nextResult = 1;

export const useTabs = create<TabsState>()((set, get) => {
  const patch = (id: string, changes: Partial<Tab>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t)) }));
  const find = (id: string) => get().tabs.find((t) => t.id === id);

  /** Imports the full file in the background; the preview stays usable. */
  const startImport = async (id: string, path: string, options: OpenOptions) => {
    const jobId = `job-${nextJob++}`;
    patch(id, { import: { jobId, status: "running", percent: null, elapsedMs: 0 } });
    const isCurrent = () => find(id)?.import?.jobId === jobId;
    try {
      const outcome = await importFile(path, options, jobId);
      const tab = find(id);
      if (!tab || !isCurrent()) {
        void closeDataset(outcome.dataset.id).catch(() => {});
        return;
      }
      patch(id, {
        info: tab.info ? { ...tab.info, dataset: outcome.dataset } : tab.info,
        import: {
          jobId,
          status: "done",
          percent: 100,
          elapsedMs: outcome.elapsedMs,
          fromCache: outcome.fromCache,
        },
      });
      if (find(id)?.view) void applyView(id);
    } catch (err) {
      if (!isCurrent()) return;
      const kind = (err as { kind?: string }).kind;
      const current = find(id)?.import;
      patch(id, {
        import: {
          jobId,
          status: kind === "cancelled" ? "cancelled" : "error",
          percent: current?.percent ?? null,
          elapsedMs: current?.elapsedMs ?? 0,
          error: err instanceof Error ? err.message : String(err),
          errorKind: kind,
        },
      });
    }
  };

  /**
   * Opens the tab's view over its full dataset. The previous view stays on
   * screen until the new one is counted; a newer request for the tab wins.
   */
  const applyView = async (id: string) => {
    const tab = find(id);
    if (!tab) return;
    const spec = tab.view ?? {};
    const base = tab.info?.dataset;
    const shown = tab.viewState?.dataset;
    if (isIdentity(spec) || !base) {
      if (shown) void closeDataset(shown.id).catch(() => {});
      // Stop a long sort that is no longer wanted.
      if (tab.viewState?.status === "running")
        void cancelQuery(tab.viewState.requestId).catch(() => {});
      patch(id, {
        viewState: isIdentity(spec) ? undefined : { status: "waiting", requestId: "" },
      });
      return;
    }
    const requestId = `view-${nextView++}`;
    patch(id, { viewState: { ...tab.viewState, status: "running", requestId, error: undefined } });
    const isCurrent = () => find(id)?.viewState?.requestId === requestId;
    try {
      const out = await openView(base.id, spec, requestId, `view:${id}`);
      if (!isCurrent()) {
        void closeDataset(out.dataset.id).catch(() => {});
        return;
      }
      const old = find(id)?.viewState?.dataset;
      if (old) void closeDataset(old.id).catch(() => {});
      patch(id, {
        viewState: {
          status: "done",
          requestId,
          dataset: out.dataset,
          spec,
          totalRows: out.totalRows,
          elapsedMs: out.elapsedMs,
          // Only a sort makes the user wait for the background part.
          sorting: !!out.materializing && (spec.sort?.length ?? 0) > 0,
        },
      });
    } catch (err) {
      if (!isCurrent() || (err as { kind?: string }).kind === "cancelled") return;
      patch(id, {
        viewState: {
          ...find(id)?.viewState,
          status: "error",
          requestId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  /** Loads info and preview in parallel; a newer load for the tab wins. */
  const load = async (id: string, path: string, options: OpenOptions) => {
    const started = performance.now();
    const requestId = `${id}:${started}`;
    patch(id, { status: "loading", options, error: undefined, import: undefined });
    try {
      const [info, preview] = await Promise.all([
        openFile(path, options),
        previewFile(path, options, requestId),
      ]);
      const current = find(id);
      if (!current || current.options !== options) return; // superseded or closed
      patch(id, { status: "ready", info, preview, previewMs: performance.now() - started });
      if (!info.dataset) void startImport(id, path, options);
      // Data available at once (Parquet in place): a kept view applies now.
      else if (find(id)?.view) void applyView(id);
    } catch (err) {
      const current = find(id);
      if (!current || current.options !== options) return;
      const kind = (err as { kind?: string }).kind;
      if (kind === "cancelled") return;
      patch(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Cancels a running import and closes the tab's dataset. */
  const release = (tab: Tab) => {
    if (tab.import?.status === "running") void cancelImport(tab.import.jobId).catch(() => {});
    const ds = tab.info?.dataset;
    if (ds) void closeDataset(ds.id).catch(() => {});
    const view = tab.viewState?.dataset;
    if (view) void closeDataset(view.id).catch(() => {});
  };

  return {
    tabs: [],
    activeId: null,
    setActive: (id) => set({ activeId: id }),
    openPath: async (path) => {
      const existing = get().tabs.find((t) => t.path === path);
      if (existing) {
        set({ activeId: existing.id });
        return;
      }
      useRecent.getState().add(path);
      const id = `tab-${nextId++}`;
      const options: OpenOptions = {};
      set((s) => ({
        tabs: [...s.tabs, { id, title: baseName(path), path, options, status: "loading" }],
        activeId: id,
      }));
      await load(id, path, options);
    },
    openPaths: async (paths) => {
      await Promise.all(paths.map((p) => get().openPath(p)));
      const last = paths.at(-1);
      const tab = last && get().tabs.find((t) => t.path === last);
      if (tab) set({ activeId: tab.id });
    },
    cycle: (step) => {
      const { tabs, activeId } = get();
      if (tabs.length === 0) return;
      const i = tabs.findIndex((t) => t.id === activeId);
      const next = tabs[(i + step + tabs.length) % tabs.length];
      if (next) set({ activeId: next.id });
    },
    reopen: async (id, options) => {
      const tab = find(id);
      if (!tab) return;
      release(tab);
      // New import settings can change the columns, so filters start over.
      patch(id, {
        info: tab.info ? { ...tab.info, dataset: null } : tab.info,
        view: undefined,
        viewState: undefined,
        layout: undefined,
      });
      await load(id, tab.path, options);
    },
    reload: async (id) => {
      const tab = find(id);
      if (!tab) return;
      release(tab);
      patch(id, {
        info: tab.info ? { ...tab.info, dataset: null } : tab.info,
        viewState: tab.view ? { status: "waiting", requestId: "" } : undefined,
      });
      // A new options object: `load` tells a newer load by identity.
      await load(id, tab.path, { ...tab.options });
    },
    cancelImport: async (id) => {
      const job = find(id)?.import;
      if (job?.status === "running") await cancelImport(job.jobId);
    },
    readDirect: async (id) => {
      const tab = find(id);
      if (!tab?.info) return;
      try {
        const dataset = await openDirect(tab.path, tab.options);
        const t = find(id);
        if (!t?.info) return;
        patch(id, {
          info: { ...t.info, dataset },
          import: { jobId: "direct", status: "done", percent: 100, elapsedMs: 0 },
        });
        if (find(id)?.view) void applyView(id);
      } catch (err) {
        patch(id, {
          import: {
            jobId: "direct",
            status: "error",
            percent: null,
            elapsedMs: 0,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
    applyProgress: (p) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.import?.jobId === p.jobId && t.import.status === "running"
            ? { ...t, import: { ...t.import, percent: p.percent, elapsedMs: p.elapsedMs } }
            : t,
        ),
      })),
    applyViewReady: (ready) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.viewState?.dataset?.id === ready.datasetId
            ? { ...t, viewState: { ...t.viewState, sorting: false, fullMs: ready.elapsedMs } }
            : t,
        ),
      })),
    setLayout: (id, layout) => patch(id, { layout }),
    setSqlName: (id, sqlName) => patch(id, { sqlName }),
    setMode: (id, mode) => patch(id, { mode }),
    setChart: (id, chart) => patch(id, { chart }),
    openResult: ({ dataset, preview, sql }) => {
      const id = `tab-${nextId++}`;
      const title = `Result ${nextResult++}`;
      const info: SourceInfo = {
        path: "",
        fileName: title,
        sizeBytes: 0,
        format: "sql",
        compression: "none",
        sniffed: null,
        excel: null,
        columns: describeColumns(preview).map((c) => ({ name: c.name, type: c.type })),
        // "Copy view as SQL" reads from the query itself.
        readerSql: `(\n${sql}\n)`,
        dataset,
      };
      set((s) => ({
        tabs: [...s.tabs, { id, title, path: "", options: {}, status: "ready", info, preview }],
        activeId: id,
      }));
      return id;
    },
    setView: async (id, view) => {
      if (!find(id)) return;
      patch(id, { view: isIdentity(view) ? undefined : view });
      await applyView(id);
    },
    cancelView: (id) => {
      const tab = find(id);
      const vs = tab?.viewState;
      if (!tab || !vs) return;
      if (vs.status === "running") {
        void cancelQuery(vs.requestId).catch(() => {});
        patch(id, {
          view: vs.dataset ? vs.spec : undefined,
          // A new request id: the cancelled request's result is ignored.
          viewState: vs.dataset
            ? { ...vs, status: "done", requestId: `${vs.requestId}:cancelled` }
            : undefined,
        });
      } else if (vs.sorting) {
        void get().setView(id, { ...tab.view, sort: [] });
      }
    },
    close: (id) => {
      const tab = find(id);
      if (tab) release(tab);
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id);
        const tabs = s.tabs.filter((t) => t.id !== id);
        const activeId =
          s.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.activeId;
        return { tabs, activeId };
      });
    },
  };
});
