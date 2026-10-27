import { call } from "./ipc";

/** One run of the SQL panel. */
export interface HistoryEntry {
  sql: string;
  /** Milliseconds since 1970. */
  ranAt: number;
  elapsedMs: number;
  rows?: number | null;
  error?: string | null;
}

export interface SavedQuery {
  name: string;
  sql: string;
  savedAt: number;
}

export function sqlHistory(search?: string, limit = 200): Promise<HistoryEntry[]> {
  return call("sql_history", { search: search || null, limit });
}

export function addSqlHistory(entry: Omit<HistoryEntry, "ranAt">): Promise<HistoryEntry> {
  return call("add_sql_history", { entry });
}

export function clearSqlHistory(): Promise<void> {
  return call("clear_sql_history");
}

export function savedQueries(): Promise<SavedQuery[]> {
  return call("saved_queries");
}

export function saveQuery(name: string, sql: string): Promise<SavedQuery> {
  return call("save_query", { name, sql });
}

export function deleteSavedQuery(name: string): Promise<boolean> {
  return call("delete_saved_query", { name });
}

/** "just now", "5 min ago", "3 h ago", "yesterday", else the date. */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  )
    return "yesterday";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The first meaningful line of a query, for a list. */
export function firstLine(sql: string): string {
  const line = sql
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("--"));
  return line ?? sql.trim();
}
