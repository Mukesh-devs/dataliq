import { call } from "./ipc";
import type { ViewSpec } from "./view";

export type ExportFormat = "csv" | "csvGz" | "tsv" | "parquet" | "json" | "ndjson" | "xlsx";

export const EXPORT_FORMATS: {
  format: ExportFormat;
  label: string;
  extension: string;
  hint: string;
}[] = [
  { format: "csv", label: "CSV", extension: "csv", hint: "Opens anywhere" },
  { format: "csvGz", label: "CSV.gz", extension: "csv.gz", hint: "CSV, gzip-compressed" },
  { format: "tsv", label: "TSV", extension: "tsv", hint: "Tab-separated" },
  { format: "parquet", label: "Parquet", extension: "parquet", hint: "Small, typed (zstd)" },
  { format: "json", label: "JSON", extension: "json", hint: "One array of objects" },
  { format: "ndjson", label: "NDJSON", extension: "ndjson", hint: "One object per line" },
  { format: "xlsx", label: "Excel", extension: "xlsx", hint: "Typed cells, .xlsx" },
];

/** Data rows one Excel sheet holds below its header row. */
export const XLSX_SHEET_ROWS = 1_048_575;

export interface ExportOptions {
  /** Column names in the first row (CSV, TSV, Excel). */
  header?: boolean;
  /** CSV only: one character. */
  delimiter?: string;
  /** Quote every value (CSV, TSV). */
  quoteAll?: boolean;
  /** strftime formats (CSV, TSV, JSON), e.g. `%d/%m/%Y`. */
  dateFormat?: string;
  timestampFormat?: string;
  /** Excel past one sheet: more sheets, or stop at the first. */
  splitSheets?: boolean;
  /** Only these view positions, as `[start, end)` ranges. */
  rows?: [number, number][];
  /** A folder with a subfolder per value of these columns (not Excel). */
  partitionBy?: string[];
  /** A folder of files of at most this many rows (not Excel). */
  rowsPerFile?: number;
  /** A folder of files of about this many bytes (not Excel). */
  maxFileBytes?: number;
}

/** How an export is split into files. */
export type SplitMode = "none" | "column" | "rows" | "size";

/** The split options, or why they can't be used. */
export function splitOptions(
  mode: SplitMode,
  column: string,
  rows: string,
  megabytes: string,
): { options: Partial<ExportOptions> } | { problem: string } {
  const n = (s: string) => Number(s.replace(/[,_\s]/g, ""));
  switch (mode) {
    case "none":
      return { options: {} };
    case "column":
      return column ? { options: { partitionBy: [column] } } : { problem: "Pick a column" };
    case "rows": {
      const r = n(rows);
      return Number.isInteger(r) && r >= 1
        ? { options: { rowsPerFile: r } }
        : { problem: "Rows per file: a whole number" };
    }
    case "size": {
      const mb = n(megabytes);
      return Number.isFinite(mb) && mb > 0
        ? { options: { maxFileBytes: Math.round(mb * 1_000_000) } }
        : { problem: "File size: a number of MB" };
    }
  }
}

export interface ExportRequest {
  datasetId: string;
  /** The view; `columns` are the exported columns in order. */
  spec: ViewSpec;
  /** Display names by column. */
  labels: Record<string, string>;
  path: string;
  format: ExportFormat;
  options: ExportOptions;
  /** Rows to expect, for progress. */
  totalRows?: number;
}

export interface ExportOutcome {
  path: string;
  rows: number;
  sheets: number;
  rowsLeftOut: number;
  /** Files written into the folder `path` (split exports); 0 for one file. */
  files: number;
  elapsedMs: number;
}

export interface ExportProgress {
  jobId: string;
  percent: number | null;
  elapsedMs: number;
}

export function exportView(request: ExportRequest, jobId: string): Promise<ExportOutcome> {
  return call<ExportOutcome>("export_view", { request, jobId });
}

export function cancelExport(jobId: string): Promise<boolean> {
  return call<boolean>("cancel_export", { jobId });
}

export async function onExportProgress(handler: (p: ExportProgress) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ExportProgress>("export-progress", (e) => handler(e.payload));
}

export function formatInfo(format: ExportFormat) {
  return EXPORT_FORMATS.find((f) => f.format === format) ?? EXPORT_FORMATS[0]!;
}

/** A file's name without its extensions, safe for a new file name. */
export function fileBase(title: string, fallback: string): string {
  return (
    title
      .replace(/\.(gz|gzip|zst|zstd)$/i, "")
      .replace(/\.[a-z0-9]{1,8}$/i, "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .trim() || fallback
  );
}

/** "sales.csv.gz" → "sales-export.parquet": never the open file's own name. */
export function defaultExportName(title: string, format: ExportFormat): string {
  return `${fileBase(title, "export")}-export.${formatInfo(format).extension}`;
}

/** The native save dialog. Resolves to null when cancelled. */
export async function pickExportPath(name: string, format: ExportFormat): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const info = formatInfo(format);
  return save({
    defaultPath: name,
    filters: [{ name: info.label, extensions: [info.extension.split(".").at(-1)!] }],
  });
}

/** Sorted indices merged into `[start, end)` ranges. */
export function toRanges(indices: Iterable<number>): [number, number][] {
  const out: [number, number][] = [];
  for (const i of indices) {
    const last = out.at(-1);
    if (last && i === last[1]) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

export function rangeRows(ranges: [number, number][]): number {
  return ranges.reduce((n, [a, b]) => n + (b - a), 0);
}

/** A data file of a folder that can be converted. */
export interface DataFile {
  path: string;
  sizeBytes: number;
  format: string;
}

export interface ConvertRequest {
  files: string[];
  /** Not Excel. */
  format: ExportFormat;
  outDir: string;
  overwrite: boolean;
}

export interface ConvertedFile {
  source: string;
  /** Null when it failed or was skipped (see `error`). */
  output: string | null;
  rows: number;
  sourceBytes: number;
  outputBytes: number;
  error: string | null;
}

export interface ConvertOutcome {
  files: ConvertedFile[];
  elapsedMs: number;
}

export interface ConvertProgress {
  jobId: string;
  done: number;
  total: number;
  file: string;
  percent: number;
}

export function listDataFiles(folder: string): Promise<DataFile[]> {
  return call<DataFile[]>("list_data_files", { folder });
}

/** Converts files one by one; cancel with `cancelExport(jobId)`. */
export function convertFiles(request: ConvertRequest, jobId: string): Promise<ConvertOutcome> {
  return call<ConvertOutcome>("convert_files", { request, jobId });
}

export async function onConvertProgress(
  handler: (p: ConvertProgress) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ConvertProgress>("convert-progress", (e) => handler(e.payload));
}

/** Formats files can be converted to (Excel is exported from a tab). */
export const CONVERT_FORMATS = EXPORT_FORMATS.filter((f) => f.format !== "xlsx");

/** The new file's name: `sales.csv.gz` → `sales.parquet` (as the backend names it). */
export function convertedName(path: string, format: ExportFormat): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const stem = name
    .replace(/\.(gz|gzip|zst|zstd)$/i, "")
    .replace(/\.(csv|txt|dat|tsv|tab|json|ndjson|jsonl|parquet|pq)$/i, "");
  return `${stem || name}.${formatInfo(format).extension}`;
}
