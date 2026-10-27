import { create } from "zustand";

/**
 * Bumped after the theme and density attributes are on <html>, so code that
 * reads CSS variables in JavaScript (the canvas grid) reads the new values.
 * Reading them when the setting changes is too early: that render runs
 * before the attributes change.
 */
export const useAppliedTheme = create<{ version: number; bump: () => void }>()((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
