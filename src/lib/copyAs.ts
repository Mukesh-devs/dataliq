import type { ValueFormat } from "./arrow";
import { formatValue, toJsonText } from "./format";

export type CopyFormat = "csv" | "tsv" | "excel" | "json" | "markdown" | "sql";

export const COPY_FORMATS: { format: CopyFormat; label: string }[] = [
  { format: "csv", label: "CSV" },
  { format: "tsv", label: "TSV" },
  { format: "excel", label: "Excel (keeps leading zeros)" },
  { format: "json", label: "JSON" },
  { format: "markdown", label: "Markdown table" },
  { format: "sql", label: "SQL INSERT" },
];

export interface CopyColumn {
  /** Real column name (used by SQL INSERT). */
  name: string;
  /** Display name (headers of CSV, TSV, Markdown and JSON keys). */
  label: string;
  format: ValueFormat;
}

/** The value as display text; NULL is null. */
const text = (value: unknown, c: CopyColumn) => formatValue(value, c.format);

/** CSV/TSV field: quoted when it holds the delimiter, a quote or a line break. */
function field(s: string, delimiter: string): string {
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function delimited(
  columns: CopyColumn[],
  rows: unknown[][],
  delimiter: string,
  headers: boolean,
): string {
  const lines = headers ? [columns.map((c) => field(c.label, delimiter)).join(delimiter)] : [];
  for (const row of rows) {
    lines.push(columns.map((c, i) => field(text(row[i], c) ?? "", delimiter)).join(delimiter));
  }
  return lines.join("\n");
}

/** Excel shows 15 significant digits; longer numbers lose their end. */
const EXCEL_DIGITS = 15;

/**
 * A cell Excel takes as typed when pasted. Text that Excel would turn into
 * a number or a date ("00123", "1-2", a 16-digit phone or card number) and
 * whole numbers too long for Excel are pasted as `="…"`, which Excel keeps
 * as that exact text.
 */
export function excelCell(value: unknown, c: CopyColumn): string {
  const s = text(value, c);
  if (s === null) return "";
  const digits = s.replace(/^-/, "").replace(/\./, "");
  if (isNumeric(c)) {
    // Long integers (ids, phone numbers stored as numbers) stay exact.
    return /^\d+$/.test(digits) && digits.length > EXCEL_DIGITS ? asExcelText(s) : s;
  }
  if (c.format.kind === "boolean") return s.toUpperCase();
  if (c.format.kind !== "text") return field(s, "\t");
  const numberLike = /^[+-]?\d[\d\s.,/:-]*$/.test(s.trim());
  const leadingZero = /^0\d/.test(s.trim());
  if (numberLike && (leadingZero || /^\d{16,}$/.test(s) || /[/:-]/.test(s) || s.startsWith("+")))
    return asExcelText(s);
  // A leading = + - @ would start a formula: an apostrophe keeps it text.
  if (!numberLike && /^[=@+-]/.test(s)) return field(`'${s}`, "\t");
  return field(s, "\t");
}

const asExcelText = (s: string) => `="${s.replace(/"/g, '""')}"`;

function excel(columns: CopyColumn[], rows: unknown[][], headers: boolean): string {
  const lines = headers ? [columns.map((c) => field(c.label, "\t")).join("\t")] : [];
  for (const row of rows) lines.push(columns.map((c, i) => excelCell(row[i], c)).join("\t"));
  return lines.join("\r\n");
}

function markdownCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

const isNumeric = (c: CopyColumn) => c.format.kind === "integer" || c.format.kind === "number";

function markdown(columns: CopyColumn[], rows: unknown[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const lines = [
    line(columns.map((c) => markdownCell(c.label))),
    line(columns.map((c) => (isNumeric(c) ? "---:" : "---"))),
  ];
  for (const row of rows) {
    lines.push(line(columns.map((c, i) => markdownCell(text(row[i], c) ?? ""))));
  }
  return lines.join("\n");
}

/** A JSON value: numbers and booleans as such, nested values parsed, the rest as text. */
function jsonValue(value: unknown, c: CopyColumn): unknown {
  const s = text(value, c);
  if (s === null) return null;
  switch (c.format.kind) {
    case "integer":
    case "number": {
      const n = Number(s);
      if (!Number.isFinite(n)) return s;
      if (String(n) === s) return n;
      // Decimals such as "12.50" are exact enough as a number with few
      // digits; big integers and long decimals stay exact as strings.
      const digits = s.replace(/[-.]/g, "").replace(/^0+/, "").length;
      return /^-?\d+\.\d+$/.test(s) && digits <= 15 ? n : s;
    }
    case "boolean":
      return value === true || s === "true";
    case "json":
      try {
        return JSON.parse(toJsonText(value)) as unknown;
      } catch {
        return s;
      }
    default:
      return s;
  }
}

function json(columns: CopyColumn[], rows: unknown[][]): string {
  const objects = rows.map((row) =>
    Object.fromEntries(columns.map((c, i) => [c.label, jsonValue(row[i], c)])),
  );
  return JSON.stringify(objects, null, 2);
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const quoteString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A DuckDB literal for a value of the column. */
export function sqlLiteral(value: unknown, c: CopyColumn): string {
  if (c.format.kind === "binary" && value instanceof Uint8Array) {
    return `from_hex('${hex(value)}')`;
  }
  const s = text(value, c);
  if (s === null) return "NULL";
  switch (c.format.kind) {
    case "integer":
    case "number":
      return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) ? s : `${quoteString(s)}::DOUBLE`;
    case "boolean":
      return value === true || s === "true" ? "true" : "false";
    case "date":
      return `DATE ${quoteString(s)}`;
    case "timestamp":
      return `TIMESTAMP ${quoteString(s)}`;
    case "time":
      return `TIME ${quoteString(s)}`;
    default:
      return quoteString(s);
  }
}

function sqlInsert(columns: CopyColumn[], rows: unknown[][], table: string): string {
  const head = `INSERT INTO ${quoteIdent(table)} (${columns.map((c) => quoteIdent(c.name)).join(", ")}) VALUES`;
  if (rows.length === 0) return `-- no rows\n${head} ();`;
  const values = rows.map(
    (row) => `  (${columns.map((c, i) => sqlLiteral(row[i], c)).join(", ")})`,
  );
  return `${head}\n${values.join(",\n")};`;
}

/**
 * Formats rows (raw values, one per column) for the clipboard. CSV, TSV and
 * Markdown include a header row of display names (`headers: false` leaves
 * it out of CSV and TSV, like Ctrl+C).
 */
export function formatRows(
  format: CopyFormat,
  columns: CopyColumn[],
  rows: unknown[][],
  opts: { table?: string; headers?: boolean } = {},
): string {
  // Markdown needs its header row; JSON and SQL name columns anyway.
  const headers = opts.headers ?? true;
  switch (format) {
    case "csv":
      return delimited(columns, rows, ",", headers);
    case "tsv":
      return delimited(columns, rows, "\t", headers);
    case "excel":
      return excel(columns, rows, headers);
    case "markdown":
      return markdown(columns, rows);
    case "json":
      return json(columns, rows);
    case "sql":
      return sqlInsert(columns, rows, opts.table ?? "data");
  }
}

/** A table name for SQL INSERT from a file name: "sales 2024.csv.gz" -> "sales 2024". */
export function tableName(fileName: string): string {
  const base = fileName.replace(/(\.(gz|zst|zstd|bz2))?$/i, "").replace(/\.[^.]+$/, "");
  return base || "data";
}
