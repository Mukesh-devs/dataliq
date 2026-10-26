import type { Table } from "apache-arrow";
import { create } from "zustand";
import { baseName, openFile, previewFile, type OpenOptions, type SourceInfo } from "../lib/files";

export type TabStatus = "loading" | "ready" | "error";

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
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  setActive: (id: string) => void;
  /** Opens a file in a new tab (or focuses it if already open). */
  openPath: (path: string) => Promise<void>;
  /** Re-opens a tab's file with new import settings. */
  reopen: (id: string, options: OpenOptions) => Promise<void>;
  close: (id: string) => void;
}

let nextId = 1;

export const useTabs = create<TabsState>()((set, get) => {
  const patch = (id: string, changes: Partial<Tab>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t)) }));

  /** Loads info and preview in parallel; a newer load for the tab wins. */
  const load = async (id: string, path: string, options: OpenOptions) => {
    const started = performance.now();
    const requestId = `${id}:${started}`;
    patch(id, { status: "loading", options, error: undefined });
    try {
      const [info, preview] = await Promise.all([
        openFile(path, options),
        previewFile(path, options, requestId),
      ]);
      const current = get().tabs.find((t) => t.id === id);
      if (!current || current.options !== options) return; // superseded or closed
      patch(id, { status: "ready", info, preview, previewMs: performance.now() - started });
    } catch (err) {
      const current = get().tabs.find((t) => t.id === id);
      if (!current || current.options !== options) return;
      const kind = (err as { kind?: string }).kind;
      if (kind === "cancelled") return;
      patch(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
    }
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
      const id = `tab-${nextId++}`;
      const options: OpenOptions = {};
      set((s) => ({
        tabs: [...s.tabs, { id, title: baseName(path), path, options, status: "loading" }],
        activeId: id,
      }));
      await load(id, path, options);
    },
    reopen: async (id, options) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab) await load(id, tab.path, options);
    },
    close: (id) =>
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id);
        const tabs = s.tabs.filter((t) => t.id !== id);
        const activeId =
          s.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.activeId;
        return { tabs, activeId };
      }),
  };
});
