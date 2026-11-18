import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The grid between the side panels never gets narrower than this. */
export const MIN_MAIN = 360;
export const SIDEBAR_WIDTH = { default: 240, min: 180 };
export const PROFILE_WIDTH = { default: 288, min: 220 };

/** A side panel's width within its limits: at least `min`, and room left for the grid. */
export function clampWidth(width: number, min: number, windowWidth: number, other: number) {
  const max = Math.max(min, windowWidth - other - MIN_MAIN);
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** Which side panels are shown (the SQL panel's state lives in the sql store). */
interface LayoutState {
  /** Left sidebar: files, columns, cache. */
  sidebar: boolean;
  /** Right panel: the column profile. */
  profile: boolean;
  setSidebar: (on: boolean) => void;
  setProfile: (on: boolean) => void;
  /**
   * The panels' widths. Kept while the app runs, not saved: a new window
   * starts at the default widths.
   */
  sidebarWidth: number;
  profileWidth: number;
  setSidebarWidth: (width: number) => void;
  setProfileWidth: (width: number) => void;
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      sidebar: true,
      profile: false,
      setSidebar: (sidebar) => set({ sidebar }),
      setProfile: (profile) => set({ profile }),
      sidebarWidth: SIDEBAR_WIDTH.default,
      profileWidth: PROFILE_WIDTH.default,
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setProfileWidth: (profileWidth) => set({ profileWidth }),
    }),
    { name: "dataliq.layout", partialize: (s) => ({ sidebar: s.sidebar, profile: s.profile }) },
  ),
);
