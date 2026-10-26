import { create } from "zustand";
import { persist } from "zustand/middleware";
import { baseName } from "../lib/files";

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}

const MAX_RECENT = 10;

interface RecentState {
  files: RecentFile[];
  add: (path: string) => void;
  remove: (path: string) => void;
  clear: () => void;
}

/** Recently opened files, newest first. Persisted in local storage. */
export const useRecent = create<RecentState>()(
  persist(
    (set) => ({
      files: [],
      add: (path) =>
        set((s) => ({
          files: [
            { path, name: baseName(path), openedAt: Date.now() },
            ...s.files.filter((f) => f.path !== path),
          ].slice(0, MAX_RECENT),
        })),
      remove: (path) => set((s) => ({ files: s.files.filter((f) => f.path !== path) })),
      clear: () => set({ files: [] }),
    }),
    { name: "bigview.recent" },
  ),
);
