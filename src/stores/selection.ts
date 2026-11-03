import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_STATS,
  STAT_ORDER,
  summarize,
  type SelectionStats,
  type SelectionSummary,
  type StatKey,
} from "../lib/selectionStats";

/**
 * Statistics of the active grid's selection, shown in the status bar. The
 * file view computes them; the status bar shows the ones the user picked.
 */
interface SelectionState {
  summary: SelectionSummary | null;
  /** Still adding up (a big selection, in DuckDB). */
  pending: boolean;
  error: string | null;
  /** Which statistics the status bar shows (kept between sessions). */
  shown: StatKey[];
  setPending: () => void;
  setResult: (stats: SelectionStats) => void;
  setError: (message: string) => void;
  clear: () => void;
  toggle: (key: StatKey) => void;
  resetShown: () => void;
}

export const useSelection = create<SelectionState>()(
  persist(
    (set) => ({
      summary: null,
      pending: false,
      error: null,
      shown: DEFAULT_STATS,
      setPending: () => set({ pending: true, error: null }),
      setResult: (stats) => set({ summary: summarize(stats), pending: false, error: null }),
      setError: (error) => set({ error, pending: false, summary: null }),
      clear: () => set({ summary: null, pending: false, error: null }),
      toggle: (key) =>
        set((s) => {
          const on = s.shown.includes(key);
          // Keep at least one statistic.
          if (on && s.shown.length === 1) return s;
          const next = on ? s.shown.filter((k) => k !== key) : [...s.shown, key];
          return { shown: STAT_ORDER.filter((k) => next.includes(k)) };
        }),
      resetShown: () => set({ shown: DEFAULT_STATS }),
    }),
    {
      name: "dataliq.selectionStats",
      partialize: (s) => ({ shown: s.shown }),
    },
  ),
);
