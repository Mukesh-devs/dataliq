import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isWindows } from "../lib/platform";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type Density = "comfortable" | "compact";
/**
 * "custom": DataLiq draws the title bar itself, one row with the menus, search
 * and window buttons (the system's is hidden). "system": the desktop's own
 * title bar, with the tabs in DataLiq's row below it.
 */
export type TitleBarStyle = "custom" | "system";
/** The sidebar's sections that fold away. */
export type SidebarSection = "files" | "columns";

interface SettingsState {
  theme: ThemePreference;
  density: Density;
  /** Who draws the title bar (Windows and Linux; macOS keeps its own). */
  titleBar: TitleBarStyle;
  setTitleBar: (style: TitleBarStyle) => void;
  /** Small histograms under the column titles. */
  headerCharts: boolean;
  setHeaderCharts: (on: boolean) => void;
  /** Look for a new version when the app starts (at most daily). */
  checkUpdates: boolean;
  setCheckUpdates: (on: boolean) => void;
  /** Bring back the last session's tabs (filters, layouts…) at startup. */
  restoreSession: boolean;
  setRestoreSession: (on: boolean) => void;
  /** Sidebar sections folded away (their titles stay). */
  collapsed: Partial<Record<SidebarSection, boolean>>;
  toggleSection: (section: SidebarSection) => void;
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
      // Windows first; Linux desktops differ more, so they keep theirs unless asked.
      titleBar: isWindows ? "custom" : "system",
      setTitleBar: (titleBar) => set({ titleBar }),
      headerCharts: true,
      setHeaderCharts: (headerCharts) => set({ headerCharts }),
      checkUpdates: true,
      setCheckUpdates: (checkUpdates) => set({ checkUpdates }),
      restoreSession: true,
      setRestoreSession: (restoreSession) => set({ restoreSession }),
      collapsed: {},
      toggleSection: (section) =>
        set((s) => ({ collapsed: { ...s.collapsed, [section]: !s.collapsed[section] } })),
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      cycleTheme: () => set((s) => ({ theme: nextTheme[s.theme] })),
    }),
    {
      name: "dataliq.settings",
      partialize: (s) => ({
        theme: s.theme,
        density: s.density,
        titleBar: s.titleBar,
        headerCharts: s.headerCharts,
        checkUpdates: s.checkUpdates,
        restoreSession: s.restoreSession,
        collapsed: s.collapsed,
      }),
    },
  ),
);

/** Resolves a preference against the OS colour scheme. */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}
