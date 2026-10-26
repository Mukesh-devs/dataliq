import { create } from "zustand";

export interface Tab {
  id: string;
  /** Display name, usually the file name. */
  title: string;
  /** Absolute path of the opened file. */
  path: string;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  setActive: (id: string) => void;
}

/** Open tabs. Opening and closing files is added in v0.1 step 10. */
export const useTabs = create<TabsState>()((set) => ({
  tabs: [],
  activeId: null,
  setActive: (id) => set({ activeId: id }),
}));
