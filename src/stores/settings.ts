import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type Density = "comfortable" | "compact";

interface SettingsState {
  theme: ThemePreference;
  density: Density;
  /** Small histograms under the column titles. */
  headerCharts: boolean;
  setHeaderCharts: (on: boolean) => void;
  /** Look for a new version when the app starts (at most daily). */
  checkUpdates: boolean;
  setCheckUpdates: (on: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: Density) => void;
  /** Cycles system -> light -> dark -> system. */
  cycleTheme: () => void;
}

const nextTheme: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

/** UI preferences. Persisted in the webview's local storage. */
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      density: "comfortable",
      headerCharts: true,
      setHeaderCharts: (headerCharts) => set({ headerCharts }),
      checkUpdates: true,
      setCheckUpdates: (checkUpdates) => set({ checkUpdates }),
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      cycleTheme: () => set((s) => ({ theme: nextTheme[s.theme] })),
    }),
    {
      name: "dataliq.settings",
      partialize: (s) => ({
        theme: s.theme,
        density: s.density,
        headerCharts: s.headerCharts,
        checkUpdates: s.checkUpdates,
      }),
    },
  ),
);

/** Resolves a preference against the OS colour scheme. */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}
