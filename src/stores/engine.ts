import { create } from "zustand";
import { cellValue } from "../lib/arrow";
import { runQuery } from "../lib/ipc";

interface EngineState {
  /** DuckDB version once the engine answered, e.g. "v1.5.6". */
  version: string | null;
  error: string | null;
  /** Pings the engine with a tiny query through the full Arrow IPC path. */
  probe: () => Promise<void>;
}

export const useEngine = create<EngineState>()((set) => ({
  version: null,
  error: null,
  probe: async () => {
    try {
      const table = await runQuery("SELECT version() AS v");
      set({ version: String(cellValue(table, 0, 0)), error: null });
    } catch (err) {
      set({ version: null, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
