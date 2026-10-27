import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type Density = "comfortable" | "compact";

interface SettingsState {
  theme: ThemePreference;
  density: Density;
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
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      cycleTheme: () => set((s) => ({ theme: nextTheme[s.theme] })),
    }),
    { name: "bigview.settings", partialize: (s) => ({ theme: s.theme, density: s.density }) },
  ),
);

/** Resolves a preference against the OS colour scheme. */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}
