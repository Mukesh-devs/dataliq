import type { Table } from "apache-arrow";
import { decodeIpc } from "./arrow";
import { call } from "./ipc";
import { isUrl, urlName } from "./remote";

/** CSV import settings. Unset fields are detected by DuckDB's sniffer. */
export interface CsvOptions {
  delimiter?: string;
  header?: boolean;
  quote?: string;
  escape?: string;
  encoding?: "utf-8" | "latin-1" | "utf-16";
  skipRows?: number;
  ignoreErrors?: boolean;
  dateFormat?: string;
  timestampFormat?: string;
}

/** Excel choices. Unset = detect (first sheet with data, header row). */
export interface ExcelOptions {
  sheet?: string;
  /** 1-based header row; 0 = no header row. */
  headerRow?: number;
}

export interface ExcelInfo {
  sheets: string[];
  sheet: string;
  /** Header row in use (1-based); 0 = none. */
  headerRow: number;
}

/** Which table of a SQLite or DuckDB file. Unset = the first table. */
export interface DatabaseOptions {
  /** "main" when unset. */
  schema?: string;
  table?: string;
}

export interface DbTable {
  schema: string;
  name: string;
  kind: "table" | "view";
  /** Known without counting (DuckDB tables only). */
  rows: number | null;
}

/** Tables of a database file and the one shown; mirrors `DatabaseInfo` in Rust. */
export interface DatabaseInfo {
  tables: DbTable[];
  schema: string;
  table: string;
  /** The name the file is attached under in the SQL panel. */
  alias: string;
}

export interface OpenOptions {
  csv?: CsvOptions;
  excel?: ExcelOptions;
  database?: DatabaseOptions;
}

export interface SniffedCsv {
  delimiter: string;
  quote: string;
  escape: string;
  newLine: string;
  skipRows: number;
  hasHeader: boolean;
  dateFormat: string | null;
  timestampFormat: string | null;
}

/** "sql": a SQL panel result opened in a tab (no file behind it). */
export type FileFormat =
  "csv" | "tsv" | "json" | "ndjson" | "parquet" | "xlsx" | "xls" | "sqlite" | "duckdb" | "sql";
/** "mixed": a folder of some compressed and some plain files. */
export type Compression = "none" | "gzip" | "zstd" | "mixed";

/** The files a folder or pattern opened together; mirrors `FileList` in Rust. */
export interface FileList {
  /** Relative to the folder (at most 500 named). */
  names: string[];
  count: number;
  /** Data files of another format, or empty. */
  skipped: number;
  /** The column saying which file a row came from. */
  column: string;
}

export interface ColumnMeta {
  name: string;
  type: string;
}

/** Full data that the grid can page through. */
export interface DatasetInfo {
  id: string;
  rowCount: number;
  /** Imported into the cache (false = read straight from the file). */
  cached?: boolean;
}

export interface ImportOutcome {
  dataset: DatasetInfo;
  fromCache: boolean;
  elapsedMs: number;
}

export interface ImportProgress {
  jobId: string;
  percent: number | null;
  elapsedMs: number;
}

export interface CacheInfo {
  dir: string;
  enabled: boolean;
  maxBytes: number;
  usedBytes: number;
  entries: number;
}

export interface AppSettings {
  memoryLimitMb: number | null;
  cacheEnabled: boolean;
  cacheMaxGb: number;
  smallFileMb: number;
}

export interface SourceInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  format: FileFormat;
  compression: Compression;
  sniffed: SniffedCsv | null;
  excel: ExcelInfo | null;
  /** SQLite and DuckDB files: their tables. */
  database?: DatabaseInfo | null;
  columns: ColumnMeta[];
  readerSql: string;
  dataset: DatasetInfo | null;
  /** A folder or pattern of files read as one table. */
  files?: FileList | null;
}

export function openFile(path: string, options: OpenOptions): Promise<SourceInfo> {
  return call<SourceInfo>("open_file", { path, options });
}

/** First rows read straight from the file (no import). */
export async function previewFile(
  path: string,
  options: OpenOptions,
  requestId?: string,
): Promise<Table> {
  const bytes = await call<ArrayBuffer>("preview_file", { path, options, requestId });
  return decodeIpc(bytes);
}

/** Rows [start, start + count) of a dataset. */
export async function fetchRows(datasetId: string, start: number, count: number): Promise<Table> {
  const bytes = await call<ArrayBuffer>("fetch_rows", { datasetId, start, count });
  return decodeIpc(bytes);
}

/** Imports a file into the cache (or reuses it). Progress arrives as events. */
export function importFile(
  path: string,
  options: OpenOptions,
  jobId: string,
): Promise<ImportOutcome> {
  return call<ImportOutcome>("import_file", { path, options, jobId });
}

export function cancelImport(jobId: string): Promise<boolean> {
  return call<boolean>("cancel_import", { jobId });
}

/** Reads a file directly without importing (slower deep scrolling). */
export function openDirect(path: string, options: OpenOptions): Promise<DatasetInfo> {
  return call<DatasetInfo>("open_direct", { path, options });
}

export function closeDataset(datasetId: string): Promise<void> {
  return call<void>("close_dataset", { datasetId });
}

export function cacheInfo(): Promise<CacheInfo> {
  return call<CacheInfo>("cache_info");
}

export function clearCache(): Promise<CacheInfo> {
  return call<CacheInfo>("clear_cache");
}

export function getSettings(): Promise<AppSettings> {
  return call<AppSettings>("get_settings");
}

/** Subscribes to import progress events. Resolves to an unsubscribe function. */
export async function onImportProgress(
  handler: (progress: ImportProgress) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ImportProgress>("import-progress", (e) => handler(e.payload));
}

export const FILE_EXTENSIONS = [
  "csv",
  "tsv",
  "tab",
  "txt",
  "gz",
  "zst",
  "json",
  "ndjson",
  "jsonl",
  "parquet",
  "xlsx",
  "xls",
  "sqlite",
  "sqlite3",
  "db",
  "db3",
  "duckdb",
  "ddb",
  // Workspaces (open the tabs they saved).
  "bigview",
];

/** Shows the native open dialog. Resolves to [] when cancelled. */
export async function pickFiles(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    directory: false,
    filters: [
      { name: "Data files", extensions: FILE_EXTENSIONS },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (picked === null) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/** A folder to open as one table, from the system dialog (null: cancelled). */
export async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: true });
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

/** A path with wildcards: several files opened as one table. */
export const isPattern = (path: string) => /[*?[]/.test(path);

/** Files passed on the command line when the app started (returned once). */
export function takeStartupFiles(): Promise<string[]> {
  return call<string[]>("take_startup_files");
}

/** Files forwarded by a second `bigview <files>` launch. */
export async function onOpenFiles(handler: (paths: string[]) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string[]>("open-files", (e) => handler(e.payload));
}

/** macOS File menu actions ("open-file", "close-tab"). */
export async function onMenu(handler: (id: string) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("menu", (e) => handler(e.payload));
}

export type DragState = "over" | "none";

/** Files dragged onto the window (Tauri delivers real paths, not File objects). */
export async function onFileDrop(
  onState: (state: DragState) => void,
  onDrop: (paths: string[]) => void,
): Promise<() => void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") onState("over");
    else if (p.type === "leave") onState("none");
    else if (p.type === "drop") {
      onState("none");
      if (p.paths.length > 0) onDrop(p.paths);
    }
  });
}

/** File name from a path on any OS. */
export function baseName(path: string): string {
  if (isUrl(path)) return urlName(path);
  return path.split(/[\\/]/).pop() || path;
}
