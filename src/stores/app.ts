import { create } from "zustand";
import { cacheInfo, clearCache, getSettings, type AppSettings, type CacheInfo } from "../lib/files";

/** The parts of the Settings tab, in order. */
export type SettingsSection =
  "appearance" | "memory" | "cache" | "export" | "assistants" | "updates" | "file-types";

interface AppState {
  settings: AppSettings | null;
  /** The Settings tab is open (next to the files' tabs). */
  settingsOpen: boolean;
  /** …and in front of them. */
  settingsActive: boolean;
  /** The part of Settings to show when it opens. */
  settingsSection: SettingsSection | null;
  /** Opens the Settings tab (or brings it to the front), at `section`. */
  showSettings: (section?: SettingsSection) => void;
  /** Back to the files, keeping the Settings tab. */
  hideSettings: () => void;
  closeSettings: () => void;
  setSettings: (settings: AppSettings) => void;
  cache: CacheInfo | null;
  load: () => Promise<void>;
  refreshCache: () => Promise<void>;
  clearCache: () => Promise<void>;
}

/** Backend settings and cache status. */
export const useApp = create<AppState>()((set) => ({
  settings: null,
  settingsOpen: false,
  settingsActive: false,
  settingsSection: null,
  showSettings: (section) =>
    set({ settingsOpen: true, settingsActive: true, settingsSection: section ?? null }),
  hideSettings: () => set({ settingsActive: false }),
  closeSettings: () => set({ settingsOpen: false, settingsActive: false, settingsSection: null }),
  setSettings: (settings) => set({ settings }),
  cache: null,
  load: async () => {
    const [settings, cache] = await Promise.all([
      getSettings().catch(() => null),
      cacheInfo().catch(() => null),
    ]);
    set({ settings, cache });
  },
  refreshCache: async () => {
    const cache = await cacheInfo().catch(() => null);
    set({ cache });
  },
  clearCache: async () => {
    const cache = await clearCache();
    set({ cache });
  },
}));

/** Size below which imports run without a progress bar. */
export function smallFileBytes(settings: AppSettings | null): number {
  return (settings?.smallFileMb ?? 100) * 1024 * 1024;
}
