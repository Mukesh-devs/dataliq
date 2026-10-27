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

/** "sales.csv.gz" → "sales-export.parquet": never the open file's own name. */
export function defaultExportName(title: string, format: ExportFormat): string {
  const base =
    title
      .replace(/\.(gz|gzip|zst|zstd)$/i, "")
      .replace(/\.[a-z0-9]{1,8}$/i, "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .trim() || "export";
  return `${base}-export.${formatInfo(format).extension}`;
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
