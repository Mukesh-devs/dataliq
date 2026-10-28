import { quoteIdent } from "./copyAs";
import { call } from "./ipc";
import type { Step } from "./recipe";
import type { Filter } from "./view";

/** Mirrors `WarningKind` in src-tauri/src/quality/mod.rs. */
export type WarningKind =
  "empty" | "spaces" | "mixedTypes" | "dateFormats" | "outliers" | "duplicates";

export interface QualityWarning {
  kind: WarningKind;
  /** The column it is about (none for duplicate rows). */
  column: string | null;
  /** Rows it is about. */
  rows: number;
  message: string;
  /** Show the rows it is about (all must match); empty for duplicates. */
  filters: Filter[];
  /** A cleaning step that fixes it. */
  fix: Step | null;
}

export interface QualityReport {
  rows: number;
  warnings: QualityWarning[];
  elapsedMs: number;
}

export function dataQuality(
  datasetId: string,
  requestId?: string,
  group?: string,
): Promise<QualityReport> {
  return call("data_quality", { datasetId, requestId, group });
}

export const KIND_NAMES: Record<WarningKind, string> = {
  empty: "Mostly empty",
  spaces: "Stray spaces",
  mixedTypes: "Mixed types",
  dateFormats: "Date formats",
  outliers: "Outliers",
  duplicates: "Duplicate rows",
};

/** The duplicated rows of `table`, each once with its number of copies. */
export function duplicatesSql(table: string): string {
  return (
    `-- Rows that appear more than once, with their number of copies\n` +
    `SELECT *, count(*) AS copies\nFROM ${quoteIdent(table)}\n` +
    `GROUP BY ALL\nHAVING count(*) > 1\nORDER BY copies DESC`
  );
}
