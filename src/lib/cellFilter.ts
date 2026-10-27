import type { ColumnInfo } from "./arrow";
import { formatValue } from "./format";
import type { Filter } from "./view";

/** Kinds that can be filtered by a cell's value (not nested values or bytes). */
const FILTERABLE = new Set(["integer", "number", "text", "boolean", "date", "timestamp", "time"]);

/**
 * A filter keeping the rows whose `column` equals a cell's raw value, or
 * (exclude) the rows that don't. NULL cells give "is null" / "is not null".
 * Null when the column's kind can't be filtered this way.
 */
export function filterForValue(
  column: ColumnInfo,
  value: unknown,
  exclude: boolean,
): Filter | null {
  if (!FILTERABLE.has(column.kind)) return null;
  const text = formatValue(value, column);
  if (text === null) return { column: column.name, op: exclude ? "notNull" : "isNull" };
  let param: string | number | boolean = text;
  if (column.kind === "boolean") param = value === true || text === "true";
  else if (column.kind === "integer" || column.kind === "number") {
    const n = Number(text);
    // Big integers and long decimals stay exact as text (DuckDB casts it).
    if (Number.isFinite(n) && String(n) === text) param = n;
  }
  const filter: Filter = { column: column.name, op: "equals", value: param };
  return exclude ? { ...filter, not: true } : filter;
}
