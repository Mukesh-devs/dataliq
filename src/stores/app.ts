import { create } from "zustand";
import { cacheInfo, clearCache, getSettings, type AppSettings, type CacheInfo } from "../lib/files";

interface AppState {
  settings: AppSettings | null;
  cache: CacheInfo | null;
  load: () => Promise<void>;
  refreshCache: () => Promise<void>;
  clearCache: () => Promise<void>;
}

/** Backend settings and cache status. */
export const useApp = create<AppState>()((set) => ({
  settings: null,
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
