import type { ColumnMeta, DatasetInfo } from "./files";
import { plural } from "./format";
import { call } from "./ipc";

/** Mirrors `Comparison` in src-tauri/src/compare/mod.rs. */
export interface Comparison {
  /** The rows that differ: status, keys, changed, then the compared columns. */
  dataset: DatasetInfo;
  columns: ColumnMeta[];
  leftRows: number;
  rightRows: number;
  added: number;
  removed: number;
  changed: number;
  same: number;
  /** Rows whose key appears more than once on that side. */
  duplicateLeft: number;
  duplicateRight: number;
  compared: string[];
  onlyLeft: string[];
  onlyRight: string[];
  retyped: { name: string; left: string; right: string }[];
  /** Changed rows per column (columns with changes only). */
  changes: { name: string; rows: number }[];
  elapsedMs: number;
}

/** What a comparison tab shows above its rows. */
export interface CompareInfo extends Comparison {
  left: string;
  right: string;
  keys: string[];
}

/** The status column of a comparison, and the column listing changed columns. */
export const STATUS = "status";
export const CHANGED = "changed";
/** Suffix of a changed column's old value. */
export const BEFORE = " (before)";

export type RowStatus = "added" | "removed" | "changed";

/** Compares `leftId` (the old version) with `rightId` by `keys`. */
export function compareFiles(
  leftId: string,
  rightId: string,
  keys: string[],
  requestId?: string,
  group?: string,
): Promise<Comparison> {
  return call("compare_files", { leftId, rightId, spec: { keys }, requestId, group });
}

/** The differing rows as one query over both files' readers. */
export function compareSql(
  leftId: string,
  rightId: string,
  keys: string[],
  leftReader: string,
  rightReader: string,
): Promise<string> {
  return call("compare_sql", { leftId, rightId, spec: { keys }, leftReader, rightReader });
}

const KEYISH = /^(id|key|code|uuid|.*[_ ]id|.*[_ ]key|.*[_ ]code)$/i;

/** Columns both sides have. */
export function commonColumns(left: ColumnMeta[], right: ColumnMeta[]): string[] {
  const names = new Set(right.map((c) => c.name));
  return left.filter((c) => names.has(c.name)).map((c) => c.name);
}

/** Key columns to start with: the common columns that look like keys, else the first. */
export function suggestKeys(left: ColumnMeta[], right: ColumnMeta[]): string[] {
  const common = commonColumns(left, right);
  const keyish = common.filter((c) => KEYISH.test(c));
  return keyish.length ? keyish.slice(0, 1) : common.slice(0, 1);
}

/** Notes about what the comparison could not match one to one. */
export function compareNotes(c: Comparison): string[] {
  const notes: string[] = [];
  if (c.duplicateLeft || c.duplicateRight)
    notes.push(
      `Repeated keys (${plural(c.duplicateLeft, "row")} before, ${plural(
        c.duplicateRight,
        "row",
      )} after) are matched in order of appearance.`,
    );
  for (const r of c.retyped)
    notes.push(`“${r.name}” is ${r.left} before and ${r.right} after: compared as text.`);
  if (c.onlyLeft.length)
    notes.push(`Only before: ${c.onlyLeft.map((n) => `“${n}”`).join(", ")} (not compared).`);
  if (c.onlyRight.length)
    notes.push(`Only after: ${c.onlyRight.map((n) => `“${n}”`).join(", ")} (not compared).`);
  return notes;
}

/** Whether a cell of a comparison row is one that changed (or its old value). */
export function isChangedCell(changed: string | null, column: string): boolean {
  if (!changed) return false;
  const name = column.endsWith(BEFORE) ? column.slice(0, -BEFORE.length) : column;
  return changed.split(", ").includes(name);
}
