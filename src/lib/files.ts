import type { Table } from "apache-arrow";
import { decodeIpc } from "./arrow";
import { call } from "./ipc";

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

export interface OpenOptions {
  csv?: CsvOptions;
  excel?: ExcelOptions;
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

export type FileFormat = "csv" | "tsv" | "json" | "ndjson" | "parquet" | "xlsx" | "xls";
export type Compression = "none" | "gzip" | "zstd";

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
  columns: ColumnMeta[];
  readerSql: string;
  dataset: DatasetInfo | null;
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
];

/** Shows the native open dialog. Resolves to null when cancelled. */
export async function pickFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "Data files", extensions: FILE_EXTENSIONS },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

/** File name from a path on any OS. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
