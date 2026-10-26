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
  type SourceInfo,
} from "../lib/files";
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
  cancelImport: (id: string) => Promise<void>;
  /** Reads the file directly instead of importing (e.g. low disk space). */
  readDirect: (id: string) => Promise<void>;
  close: (id: string) => void;
  /** Applies an `import-progress` event (subscribed once by the App). */
  applyProgress: (progress: ImportProgress) => void;
}

let nextId = 1;
let nextJob = 1;

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
      patch(id, { info: tab.info ? { ...tab.info, dataset: null } : tab.info });
      await load(id, tab.path, options);
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
