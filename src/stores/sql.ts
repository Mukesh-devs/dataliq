import type { Table } from "apache-arrow";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { cancelQuery, runQuery } from "../lib/ipc";
import { closeDataset, fetchRows, type DatasetInfo } from "../lib/files";
import { errorOffset, errorText, returnsRows, splitStatements, sqlResult } from "../lib/sql";
import { formatSql } from "../lib/sqlFormat";
import { addSqlHistory } from "../lib/sqlLibrary";

/** What the store needs from the mounted editor. */
export interface EditorHandle {
  runnable(): { script: string; base: number };
  replace(text: string): void;
  /** Types `text` at the cursor (over the selection). */
  insert(text: string): void;
  focus(): void;
}

/** Rows shown of a statement that isn't a query (EXPLAIN, PRAGMA …). */
export const MAX_RESULT_ROWS = 10_000;

/** A query result's first page, fetched with it. */
const RESULT_PAGE = 500;

export const MIN_PANEL_HEIGHT = 160;

/** An open file as a SQL table, for autocomplete. */
export interface SqlTable {
  name: string;
  columns: string[];
  /** The tab it comes from. */
  tabId?: string;
  /** `current_view`: the active tab's filtered, sorted rows. */
  current?: boolean;
}

export interface SqlResult {
  /**
   * The rows: a query's first page (all of them are in `dataset`), or the
   * rows of another statement as they came (EXPLAIN, PRAGMA …).
   */
  table: Table;
  /** A query's rows as a pageable dataset. */
  dataset?: DatasetInfo;
  /** Opened in a tab, which now owns (and will close) the dataset. */
  owned?: boolean;
  /** The statement whose rows these are (the last one run). */
  statement: string;
  /** Statements run. */
  count: number;
  elapsedMs: number;
  /** Rows without a dataset: more than MAX_RESULT_ROWS; only those are shown. */
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
  /** Which list is open next to the editor: past runs or saved queries. */
  library: "history" | "saved" | null;
  setLibrary: (library: "history" | "saved" | null) => void;
  /** The result was opened in a tab: don't close its dataset on the next run. */
  markOwned: () => void;
  /** The mounted editor (none while the panel is closed). */
  editor: EditorHandle | null;
  setEditor: (editor: EditorHandle | null) => void;
  /** Runs the editor's selection, or all of it. */
  runEditor: () => void;
  /** Formats the editor's text; returns an error message if it can't. */
  formatEditor: () => string | null;
  /**
   * Opens the panel and puts `text` in the editor, replacing what is there
   * (undoable: Ctrl+Z brings the old text back).
   */
  load: (text: string) => void;
}

let nextRun = 1;

/** Adds a run to the history (in the background; a failure only loses the entry). */
function remember(script: string, started: number, outcome: { rows?: number; error?: string }) {
  void addSqlHistory({
    sql: script.trim(),
    elapsedMs: Math.round(performance.now() - started),
    ...outcome,
  }).catch(() => {});
}

export const useSql = create<SqlState>()(
  persist(
    (set, get, api) => ({
      open: false,
      height: 320,
      text: "",
      tables: [],
      running: null,
      editor: null,
      library: null,
      setLibrary: (library) => set({ library }),
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
      load: (text) => {
        const put = (editor: EditorHandle) => {
          editor.replace(text);
          setTimeout(() => editor.focus(), 0);
        };
        set({ open: true, library: null });
        const editor = get().editor;
        if (editor) return put(editor);
        // The panel was closed: wait for its editor to mount.
        const stop = api.subscribe((s) => {
          if (!s.editor) return;
          stop();
          put(s.editor);
        });
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
        let dataset: DatasetInfo | undefined;
        for (const [i, st] of statements.entries()) {
          const last = i === statements.length - 1;
          try {
            if (last && returnsRows(st.text)) {
              // A query: keep all its rows, show the first page now.
              dataset = await sqlResult(st.text, requestId);
              if (!isCurrent()) {
                void closeDataset(dataset.id).catch(() => {});
                return;
              }
              table = await fetchRows(dataset.id, 0, RESULT_PAGE);
            } else {
              table = await runQuery(st.text, {
                // Only the last statement's rows are shown.
                maxRows: last ? MAX_RESULT_ROWS + 1 : 1,
                requestId,
                group: "sql",
                session: true,
              });
            }
          } catch (e) {
            if (!isCurrent()) return;
            const kind = (e as { kind?: string }).kind;
            const message = e instanceof Error ? e.message : String(e);
            const at = errorOffset(message, st.text);
            if (kind !== "cancelled") {
              remember(script, started, { error: errorText(message) });
            }
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
        const truncated = !dataset && table!.numRows > MAX_RESULT_ROWS;
        remember(script, started, { rows: dataset?.rowCount ?? table!.numRows });
        const previous = get().result;
        if (previous?.dataset && !previous.owned) {
          void closeDataset(previous.dataset.id).catch(() => {});
        }
        set({
          running: null,
          result: {
            table: truncated ? table!.slice(0, MAX_RESULT_ROWS) : table!,
            dataset,
            statement: last.text,
            count: statements.length,
            elapsedMs: Math.round(performance.now() - started),
            truncated,
          },
        });
      },
      markOwned: () => {
        const r = get().result;
        if (r) set({ result: { ...r, owned: true } });
      },
      cancel: () => {
        const id = get().running;
        if (!id) return;
        void cancelQuery(id).catch(() => {});
        set({ running: null, error: { message: "The query was cancelled.", offset: null } });
      },
    }),
    {
      name: "dataliq.sql",
      partialize: (s) => ({ open: s.open, height: s.height, text: s.text }),
    },
  ),
);
