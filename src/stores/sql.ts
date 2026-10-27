import type { Table } from "apache-arrow";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { cancelQuery, runQuery } from "../lib/ipc";
import { errorOffset, errorText, splitStatements } from "../lib/sql";
import { formatSql } from "../lib/sqlFormat";

/** What the store needs from the mounted editor. */
export interface EditorHandle {
  runnable(): { script: string; base: number };
  replace(text: string): void;
  focus(): void;
}

/** Rows of a result shown in the panel (more are counted, not shown). */
export const MAX_RESULT_ROWS = 10_000;

export const MIN_PANEL_HEIGHT = 160;

/** An open file as a SQL table, for autocomplete. */
export interface SqlTable {
  name: string;
  columns: string[];
}

export interface SqlResult {
  table: Table;
  /** The statement whose rows these are (the last one run). */
  statement: string;
  /** Statements run. */
  count: number;
  elapsedMs: number;
  /** More than MAX_RESULT_ROWS rows; only those are shown. */
  truncated: boolean;
}

export interface SqlError {
  message: string;
  /** Where the error is in the editor text, when DuckDB says. */
  offset: number | null;
}

interface SqlState {
  open: boolean;
  /** Panel height in px. */
  height: number;
  /** Editor text (kept across restarts). */
  text: string;
  tables: SqlTable[];
  running: string | null;
  result?: SqlResult;
  error?: SqlError;
  setOpen: (open: boolean) => void;
  setHeight: (height: number) => void;
  setText: (text: string) => void;
  setTables: (tables: SqlTable[]) => void;
  /**
   * Runs every statement of `script` in order and shows the last one's rows.
   * `base` is where `script` starts in the editor text (a selection).
   */
  run: (script: string, base?: number) => Promise<void>;
  cancel: () => void;
  /** The mounted editor (none while the panel is closed). */
  editor: EditorHandle | null;
  setEditor: (editor: EditorHandle | null) => void;
  /** Runs the editor's selection, or all of it. */
  runEditor: () => void;
  /** Formats the editor's text; returns an error message if it can't. */
  formatEditor: () => string | null;
}

let nextRun = 1;

export const useSql = create<SqlState>()(
  persist(
    (set, get) => ({
      open: false,
      height: 320,
      text: "",
      tables: [],
      running: null,
      editor: null,
      setEditor: (editor) => set({ editor }),
      runEditor: () => {
        const r = get().editor?.runnable();
        if (r) void get().run(r.script, r.base);
      },
      formatEditor: () => {
        try {
          get().editor?.replace(formatSql(get().text));
          return null;
        } catch (e) {
          return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
        }
      },
      setOpen: (open) => set({ open }),
      setHeight: (height) => set({ height: Math.max(MIN_PANEL_HEIGHT, Math.round(height)) }),
      setText: (text) => set({ text }),
      setTables: (tables) => set({ tables }),
      run: async (script, base = 0) => {
        const statements = splitStatements(script);
        if (statements.length === 0) return;
        const requestId = `sql-${nextRun++}`;
        const isCurrent = () => get().running === requestId;
        set({ running: requestId, error: undefined });
        const started = performance.now();
        let table: Table | undefined;
        for (const st of statements) {
          try {
            table = await runQuery(st.text, {
              maxRows: MAX_RESULT_ROWS + 1,
              requestId,
              group: "sql",
              session: true,
            });
          } catch (e) {
            if (!isCurrent()) return;
            const kind = (e as { kind?: string }).kind;
            const message = e instanceof Error ? e.message : String(e);
            const at = errorOffset(message, st.text);
            set({
              running: null,
              error:
                kind === "cancelled"
                  ? { message: "The query was cancelled.", offset: null }
                  : {
                      message: errorText(message),
                      offset: at === null ? null : base + st.from + at,
                    },
            });
            return;
          }
          if (!isCurrent()) return;
        }
        const last = statements[statements.length - 1]!;
        const truncated = table!.numRows > MAX_RESULT_ROWS;
        set({
          running: null,
          result: {
            table: truncated ? table!.slice(0, MAX_RESULT_ROWS) : table!,
            statement: last.text,
            count: statements.length,
            elapsedMs: Math.round(performance.now() - started),
            truncated,
          },
        });
      },
      cancel: () => {
        const id = get().running;
        if (!id) return;
        void cancelQuery(id).catch(() => {});
        set({ running: null, error: { message: "The query was cancelled.", offset: null } });
      },
    }),
    {
      name: "bigview.sql",
      partialize: (s) => ({ open: s.open, height: s.height, text: s.text }),
    },
  ),
);
