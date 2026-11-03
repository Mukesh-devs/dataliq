import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Filter, SortKey } from "../lib/view";

/**
 * Saved filters (with the search and sort), reusable on any file that has
 * the columns they use, e.g. the same report every month.
 */
export interface FilterPreset {
  name: string;
  filters: Filter[];
  search?: string;
  sort?: SortKey[];
  savedAt: number;
}

/** The columns a preset needs. */
export function presetColumns(p: FilterPreset): string[] {
  return [...new Set([...p.filters.map((f) => f.column), ...(p.sort ?? []).map((k) => k.column)])];
}

/** The columns a preset needs that `columns` lacks. */
export function missingColumns(p: FilterPreset, columns: readonly string[]): string[] {
  const have = new Set(columns);
  return presetColumns(p).filter((c) => !have.has(c));
}

interface PresetState {
  presets: FilterPreset[];
  /** Saves (or replaces, by name in any case) a preset. */
  save: (preset: Omit<FilterPreset, "savedAt">) => void;
  remove: (name: string) => void;
}

export const usePresets = create<PresetState>()(
  persist(
    (set) => ({
      presets: [],
      save: (p) =>
        set((s) => ({
          presets: [
            ...s.presets.filter((x) => x.name.toLowerCase() !== p.name.trim().toLowerCase()),
            { ...p, name: p.name.trim(), savedAt: Date.now() },
          ].sort((a, b) => a.name.localeCompare(b.name)),
        })),
      remove: (name) => set((s) => ({ presets: s.presets.filter((p) => p.name !== name) })),
    }),
    { name: "dataliq.filterPresets" },
  ),
);
