import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Which side panels are shown (the SQL panel's state lives in the sql store). */
interface LayoutState {
  /** Left sidebar: files, columns, cache. */
  sidebar: boolean;
  /** Right panel: the column profile. */
  profile: boolean;
  setSidebar: (on: boolean) => void;
  setProfile: (on: boolean) => void;
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      sidebar: true,
      profile: false,
      setSidebar: (sidebar) => set({ sidebar }),
      setProfile: (profile) => set({ profile }),
    }),
    { name: "bigview.layout", partialize: (s) => ({ sidebar: s.sidebar, profile: s.profile }) },
  ),
);
