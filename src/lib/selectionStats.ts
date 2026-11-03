import type { ColumnKind, ValueFormat } from "./arrow";
import { formatValue } from "./format";
import { call } from "./ipc";
import type { ProfileKind, ViewSpec } from "./view";

/**
 * Statistics of the grid's selection, like a spreadsheet's status bar:
 * computed in the UI from loaded rows when the selection is small, by one
 * DuckDB aggregate (`selection_stats`) when it is big.
 */

/** Statistics of one selected column (the backend's shape). */
export interface ColumnStats {
  column: string;
  kind: ProfileKind;
  /** Cells that are not NULL (empty text included). */
  values: number;
  /** Text cells holding "". */
  empty: number;
  /** Numbers only. */
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** Dates, timestamps and text. */
  minText: string | null;
  maxText: string | null;
  /** When asked for. */
  distinct: number | null;
}

export interface SelectionStats {
  rows: number;
  columns: ColumnStats[];
  distinctApprox: boolean;
  elapsedMs?: number;
}

/** The selection's rows: `[start, end)` view positions, or every row. */
export type SelectionRows = [number, number][] | "all";

/** Up to this many rows are added up in the UI (from the loaded pages). */
export const LOCAL_MAX_ROWS = 2_000;

export function selectionStats(
  datasetId: string,
  spec: ViewSpec,
  columns: string[],
  rows: SelectionRows,
  distinct: boolean,
  group?: string,
): Promise<SelectionStats> {
  return call("selection_stats", {
    datasetId,
    spec,
    columns,
    rows: rows === "all" ? null : rows,
    distinct,
    group,
  });
}

/** Rows in a selection of `total` rows. */
export function rowCount(rows: SelectionRows, total: number): number {
  if (rows === "all") return total;
  return rows.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
}

/** "all" when the ranges cover every row (a column selection). */
export function normalizeRows(rows: [number, number][], total: number): SelectionRows {
  return rows.length === 1 && rows[0]![0] <= 0 && rows[0]![1] >= total ? "all" : rows;
}

/** The statistics kind of a grid column (as the backend classifies it). */
export function statsKind(kind: ColumnKind): ProfileKind {
  switch (kind) {
    case "integer":
    case "number":
      return "number";
    case "date":
    case "timestamp":
      return "temporal";
    case "text":
      return "text";
    case "boolean":
      return "boolean";
    default:
      return "other";
  }
}

/** A cell of a number column as a JS number (bigints and decimals too). */
function toNumber(v: unknown, format: ValueFormat): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  const n = Number(formatValue(v, format));
  return Number.isFinite(n) ? n : null;
}

/**
 * Statistics of loaded values: `values[r][c]` is row r of column c, in the
 * order of `columns`.
 */
export function computeStats(
  columns: readonly (ValueFormat & { name: string })[],
  values: readonly unknown[][],
  distinct: boolean,
): SelectionStats {
  const stats = columns.map((col, c): ColumnStats => {
    const kind = statsKind(col.kind);
    let count = 0;
    let empty = 0;
    let sum = 0;
    let numbers = 0;
    let min: number | null = null;
    let max: number | null = null;
    // Dates compare by their raw value, text as text.
    let lo: { key: number | string; text: string } | null = null;
    let hi: { key: number | string; text: string } | null = null;
    const seen = distinct ? new Set<string>() : null;
    for (const row of values) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      count++;
      if (seen) seen.add(typeof v === "object" ? (formatValue(v, col) ?? "") : String(v));
      if (kind === "number") {
        const n = toNumber(v, col);
        if (n === null) continue;
        numbers++;
        sum += n;
        if (min === null || n < min) min = n;
        if (max === null || n > max) max = n;
      } else if (kind === "temporal" || kind === "text") {
        if (kind === "text" && v === "") empty++;
        const key = kind === "temporal" && typeof v === "number" ? v : String(v);
        if (!lo || key < lo.key) lo = { key, text: formatValue(v, col) ?? "" };
        if (!hi || key > hi.key) hi = { key, text: formatValue(v, col) ?? "" };
      }
    }
    return {
      column: col.name,
      kind,
      values: count,
      empty,
      sum: numbers > 0 ? sum : null,
      avg: numbers > 0 ? sum / numbers : null,
      min,
      max,
      minText: lo?.text ?? null,
      maxText: hi?.text ?? null,
      distinct: seen ? seen.size : null,
    };
  });
  return { rows: values.length, columns: stats, distinctApprox: false };
}

/** What the status bar shows for a selection. */
export interface SelectionSummary {
  rows: number;
  columns: number;
  cells: number;
  /** Cells with a value: not NULL and not "". */
  count: number;
  /** NULL or "" cells. */
  blank: number;
  /** Cells holding a number. */
  numbers: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** Without numbers: the range of one date or text column. */
  minText: string | null;
  maxText: string | null;
  /** One column only. */
  distinct: number | null;
  distinctApprox: boolean;
}

/** Combines per-column statistics like a spreadsheet does. */
export function summarize(stats: SelectionStats): SelectionSummary {
  const cols = stats.columns;
  const values = cols.reduce((n, c) => n + c.values, 0);
  const empty = cols.reduce((n, c) => n + c.empty, 0);
  const numeric = cols.filter((c) => c.kind === "number" && c.sum !== null);
  // Numbers per column: the count of a number column is its non-NULL cells.
  const numbers = cols.filter((c) => c.kind === "number").reduce((n, c) => n + c.values, 0);
  const sum = numeric.length > 0 ? numeric.reduce((n, c) => n + (c.sum ?? 0), 0) : null;
  const pick = (f: (a: number, b: number) => number, key: "min" | "max") =>
    numeric.reduce<number | null>((m, c) => {
      const v = c[key];
      return v === null ? m : m === null ? v : f(m, v);
    }, null);
  const single = cols.length === 1 ? cols[0]! : null;
  const ranged = single && numeric.length === 0 ? single : null;
  const cells = stats.rows * cols.length;
  return {
    rows: stats.rows,
    columns: cols.length,
    cells,
    count: values - empty,
    blank: cells - values + empty,
    numbers,
    sum,
    avg: sum !== null && numbers > 0 ? sum / numbers : null,
    min: pick(Math.min, "min"),
    max: pick(Math.max, "max"),
    minText: ranged?.minText ?? null,
    maxText: ranged?.maxText ?? null,
    distinct: single?.distinct ?? null,
    distinctApprox: stats.distinctApprox,
  };
}

/** The statistics the status bar can show. */
export type StatKey = "count" | "numbers" | "sum" | "avg" | "min" | "max" | "distinct" | "blank";

export const STAT_LABELS: Record<StatKey, string> = {
  count: "Count",
  numbers: "Numerical count",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
  distinct: "Distinct",
  blank: "Blank",
};

export const STAT_ORDER: StatKey[] = [
  "count",
  "numbers",
  "sum",
  "avg",
  "min",
  "max",
  "distinct",
  "blank",
];

export const DEFAULT_STATS: StatKey[] = ["count", "sum", "avg", "min", "max"];

/** A statistic for display: whole numbers with separators, others to 4 decimals. */
export function formatStatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  const abs = Math.abs(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: abs >= 1000 ? 2 : 4 });
}

/**
 * The shown statistics that apply to `s`, as label, display text and the
 * value to copy (plain, without separators).
 */
export function statItems(
  s: SelectionSummary,
  shown: readonly StatKey[],
): { key: StatKey; label: string; text: string; copy: string }[] {
  const out: { key: StatKey; label: string; text: string; copy: string }[] = [];
  const add = (key: StatKey, text: string, copy: string) =>
    out.push({ key, label: STAT_LABELS[key], text, copy });
  const num = (key: StatKey, v: number | null) => {
    if (v !== null) add(key, formatStatNumber(v), String(v));
  };
  for (const key of STAT_ORDER) {
    if (!shown.includes(key)) continue;
    switch (key) {
      case "count":
        add(key, s.count.toLocaleString("en-US"), String(s.count));
        break;
      case "numbers":
        if (s.numbers > 0) add(key, s.numbers.toLocaleString("en-US"), String(s.numbers));
        break;
      case "sum":
      case "avg":
        num(key, s[key]);
        break;
      case "min":
      case "max": {
        const n = s[key];
        const text = key === "min" ? s.minText : s.maxText;
        if (n !== null) num(key, n);
        else if (text !== null) add(key, text, text);
        break;
      }
      case "distinct":
        if (s.distinct !== null)
          add(
            key,
            `${s.distinctApprox ? "≈" : ""}${s.distinct.toLocaleString("en-US")}`,
            String(s.distinct),
          );
        break;
      case "blank":
        if (s.blank > 0) add(key, s.blank.toLocaleString("en-US"), String(s.blank));
        break;
    }
  }
  return out;
}
