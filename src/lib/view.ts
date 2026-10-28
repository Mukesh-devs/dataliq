import type { ColumnKind } from "./arrow";
import type { DatasetInfo } from "./files";
import { call, type Param } from "./ipc";

/** One test on a column; mirrors `FilterOp` in src-tauri/src/view/mod.rs. */
export type FilterOp =
  | { op: "contains" | "startsWith" | "endsWith"; value: string; caseSensitive?: boolean }
  | { op: "regex"; pattern: string }
  | { op: "empty" | "isNull" | "notNull" }
  | { op: "equals" | "gt" | "gte" | "lt" | "lte"; value: Param }
  | { op: "range"; min?: Param; max?: Param }
  | { op: "lastDays"; days: number }
  | { op: "in"; values: Param[] };

export type Filter = FilterOp & {
  column: string;
  /** Keep the rows that do not match (cells where the test is NULL too). */
  not?: boolean;
};

export interface SortKey {
  column: string;
  descending?: boolean;
}

/** What the user asked to see; mirrors `ViewSpec` in Rust. */
export interface ViewSpec {
  filters?: Filter[];
  sort?: SortKey[];
  search?: string;
  columns?: string[];
}

export interface OpenedView {
  dataset: DatasetInfo;
  totalRows: number;
  elapsedMs: number;
  /** Still being written out in the background (see `onViewReady`). */
  materializing?: boolean;
}

/** A view has been written out in full (`view-ready` event). */
export interface ViewReady {
  datasetId: string;
  elapsedMs: number;
}

export async function onViewReady(handler: (ready: ViewReady) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ViewReady>("view-ready", (e) => handler(e.payload));
}

export interface ValueCount {
  /** The value as text; null = NULL. */
  value: string | null;
  count: number;
}

export interface ValueList {
  values: ValueCount[];
  truncated: boolean;
}

export function isIdentity(spec: ViewSpec): boolean {
  return !spec.filters?.length && !spec.sort?.length && !spec.search && !spec.columns;
}

/** Opens a view of a dataset as a new pageable dataset (close it when replaced). */
export function openView(
  datasetId: string,
  spec: ViewSpec,
  requestId?: string,
  group?: string,
): Promise<OpenedView> {
  return call("open_view", { datasetId, spec, requestId, group });
}

/** Most frequent values of a column under the view's other filters. */
export function columnValues(
  datasetId: string,
  spec: ViewSpec,
  column: string,
  search?: string,
  limit?: number,
  group?: string,
): Promise<ValueList> {
  return call("column_values", { datasetId, spec, column, search, limit, group });
}

/** Which family of filters fits a column. */
export type FilterFamily = "text" | "number" | "date" | "boolean";

export function filterFamily(kind: ColumnKind): FilterFamily {
  switch (kind) {
    case "integer":
    case "number":
      return "number";
    case "date":
    case "timestamp":
    case "time":
      return "date";
    case "boolean":
      return "boolean";
    default:
      return "text";
  }
}

const OP_LABELS: Record<FilterOp["op"], string> = {
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
  regex: "matches",
  empty: "is empty",
  isNull: "is null",
  notNull: "is not null",
  equals: "=",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  range: "between",
  lastDays: "in the last",
  in: "is one of",
};

const NOT_LABELS: Partial<Record<FilterOp["op"], string>> = {
  contains: "doesn't contain",
  startsWith: "doesn't start with",
  endsWith: "doesn't end with",
  regex: "doesn't match",
  empty: "is not empty",
  isNull: "is not null",
  notNull: "is null",
  equals: "≠",
  in: "is not one of",
};

function show(v: Param | undefined): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

/** Short text for a filter chip, e.g. `name contains "ann"`. */
export function describeFilter(f: Filter, kind?: ColumnKind): string {
  const label = (f.not && NOT_LABELS[f.op]) || OP_LABELS[f.op];
  const prefix = f.not && !NOT_LABELS[f.op] ? "not " : "";
  const date = kind && filterFamily(kind) === "date";
  const lit = (v: Param | undefined) => (date && typeof v === "string" ? v : show(v));
  let rest = "";
  switch (f.op) {
    case "contains":
    case "startsWith":
    case "endsWith":
      rest = ` ${show(f.value)}${f.caseSensitive ? " (match case)" : ""}`;
      break;
    case "regex":
      rest = ` /${f.pattern}/`;
      break;
    case "equals":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      rest = ` ${lit(f.value)}`;
      break;
    case "range":
      if (f.min !== undefined && f.max !== undefined) rest = ` ${lit(f.min)} and ${lit(f.max)}`;
      else if (f.min !== undefined) return `${prefix}${f.column} ≥ ${lit(f.min)}`;
      else if (f.max !== undefined) return `${prefix}${f.column} ≤ ${lit(f.max)}`;
      break;
    case "lastDays":
      rest = ` ${f.days} ${f.days === 1 ? "day" : "days"}`;
      break;
    case "in": {
      const shown = f.values.slice(0, 3).map(lit).join(", ");
      const more = f.values.length > 3 ? ` +${f.values.length - 3}` : "";
      rest = ` ${shown}${more}`;
      break;
    }
  }
  return `${prefix}${f.column} ${label}${rest}`;
}

/**
 * The sort after a click on `column`'s header. A plain click sorts by that
 * column alone, cycling ascending → descending → unsorted; with `add` (Shift)
 * the column is added as the next key, or its direction cycles in place.
 */
export function toggleSort(sort: SortKey[], column: string, add: boolean): SortKey[] {
  const i = sort.findIndex((k) => k.column === column);
  const current = sort[i];
  const next = !current ? { column } : !current.descending ? { column, descending: true } : null;
  if (add) {
    if (i < 0) return [...sort, { column }];
    return next ? sort.map((k, j) => (j === i ? next : k)) : sort.filter((_, j) => j !== i);
  }
  if (sort.length > 1 || !current) return [{ column }];
  return next ? [next] : [];
}

/** Header arrow for a sorted column: "↑", "↓", or "↑2" when several keys. */
export function sortMark(sort: SortKey[], column: string): string {
  const i = sort.findIndex((k) => k.column === column);
  if (i < 0) return "";
  const arrow = sort[i]!.descending ? "↓" : "↑";
  return sort.length > 1 ? `${arrow}${i + 1}` : arrow;
}

/** What kind of statistics a column gets; mirrors `ProfileKind` in Rust. */
export type ProfileKind = "number" | "temporal" | "text" | "boolean" | "other";

/** One histogram bar: values in [lo, hi) (seconds since 1970 for dates). */
export interface Bin {
  lo: number;
  hi: number;
  count: number;
}

export interface ColumnProfile {
  column: string;
  type: string;
  kind: ProfileKind;
  rows: number;
  nulls: number;
  distinct: number | null;
  /** `distinct` is an estimate (very large views). */
  distinctApprox: boolean;
  min: string | null;
  max: string | null;
  mean: number | null;
  stddev: number | null;
  histogram: Bin[] | null;
  top: ValueCount[];
  topTruncated: boolean;
  /**
   * `top` was chosen by an estimate (nearly every value differs): the counts
   * are exact, but a value as common as the last one listed may be missing.
   */
  topApprox: boolean;
  elapsedMs: number;
}

/** Header chart data; boolean columns have three bars: true, false, null. */
export interface ColumnHistogram {
  column: string;
  kind: ProfileKind;
  bins: Bin[];
}

/** The view's filters and search only: sorting doesn't change statistics. */
export function statsSpec(spec: ViewSpec): ViewSpec {
  return { filters: spec.filters, search: spec.search };
}

export function columnProfile(
  datasetId: string,
  spec: ViewSpec,
  column: string,
  group?: string,
): Promise<ColumnProfile> {
  return call("column_profile", { datasetId, spec: statsSpec(spec), column, group });
}

export function columnHistograms(
  datasetId: string,
  spec: ViewSpec,
  columns: string[],
  group?: string,
): Promise<ColumnHistogram[]> {
  return call("column_histograms", { datasetId, spec: statsSpec(spec), columns, group });
}

/**
 * The view as standalone DuckDB SQL over `reader` (the file's reader call):
 * `spec.columns` in order, renamed by `labels`, every value inlined.
 */
export function viewSql(
  datasetId: string,
  spec: ViewSpec,
  reader: string,
  labels: Record<string, string>,
): Promise<string> {
  return call("view_sql", { datasetId, spec, reader, labels });
}
