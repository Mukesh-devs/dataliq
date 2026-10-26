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

export interface OpenOptions {
  csv?: CsvOptions;
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

export interface SourceInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  format: FileFormat;
  compression: Compression;
  sniffed: SniffedCsv | null;
  columns: ColumnMeta[];
  readerSql: string;
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
