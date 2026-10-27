import type { Param } from "../../lib/ipc";
import type { Filter, FilterFamily } from "../../lib/view";

/** Conditions offered in the editor (boolean "is true/false" map to `equals`). */
export type UiOp =
  | "contains"
  | "equals"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "empty"
  | "range"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "lastDays"
  | "in"
  | "isTrue"
  | "isFalse"
  | "isNull"
  | "notNull";

/** What the editor's inputs hold while the user types. */
export interface Draft {
  op: UiOp;
  value: string;
  /** Upper bound for "between". */
  value2: string;
  caseSensitive: boolean;
  /** Exclude matching rows. */
  not: boolean;
  days: string;
  /** Picked values for "is one of" (null = NULL). */
  selected: (string | null)[];
}

const COMMON: UiOp[] = ["in", "isNull", "notNull"];

export const OPS: Record<FilterFamily, UiOp[]> = {
  text: ["contains", "equals", "startsWith", "endsWith", "regex", "empty", ...COMMON],
  number: ["equals", "range", "gt", "gte", "lt", "lte", ...COMMON],
  date: ["range", "lt", "gt", "equals", "lastDays", ...COMMON],
  boolean: ["isTrue", "isFalse", "isNull", "notNull"],
};

export function opLabel(op: UiOp, family: FilterFamily): string {
  if (family === "date") {
    if (op === "lt") return "before";
    if (op === "gt") return "after";
    if (op === "equals") return "on";
  }
  const labels: Record<UiOp, string> = {
    contains: "contains",
    equals: "equals",
    startsWith: "starts with",
    endsWith: "ends with",
    regex: "matches regex",
    empty: "is empty",
    range: "between",
    gt: "greater than",
    gte: "at least",
    lt: "less than",
    lte: "at most",
    lastDays: "in the last … days",
    in: "is one of",
    isTrue: "is true",
    isFalse: "is false",
    isNull: "is null",
    notNull: "is not null",
  };
  return labels[op];
}

/** Ops whose result can't usefully be negated (null tests are each other's opposite). */
export function canNegate(op: UiOp): boolean {
  return !["isNull", "notNull", "isTrue", "isFalse"].includes(op);
}

export function emptyDraft(family: FilterFamily): Draft {
  return {
    op: OPS[family][0]!,
    value: "",
    value2: "",
    caseSensitive: false,
    not: false,
    days: "30",
    selected: [],
  };
}

const text = (v: Param | undefined) => (v === null || v === undefined ? "" : String(v));

/** The editor state for an existing filter. */
export function fromFilter(f: Filter, family: FilterFamily): Draft {
  const d: Draft = { ...emptyDraft(family), not: f.not ?? false };
  switch (f.op) {
    case "contains":
    case "startsWith":
    case "endsWith":
      return { ...d, op: f.op, value: f.value, caseSensitive: f.caseSensitive ?? false };
    case "regex":
      return { ...d, op: "regex", value: f.pattern };
    case "equals":
      if (family === "boolean" && typeof f.value === "boolean")
        return { ...d, op: f.value ? "isTrue" : "isFalse" };
      return { ...d, op: "equals", value: text(f.value) };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { ...d, op: f.op, value: text(f.value) };
    case "range":
      return { ...d, op: "range", value: text(f.min), value2: text(f.max) };
    case "lastDays":
      return { ...d, op: "lastDays", days: String(f.days) };
    case "in":
      return { ...d, op: "in", selected: f.values.map((v) => (v === null ? null : String(v))) };
    case "empty":
    case "isNull":
    case "notNull":
      return { ...d, op: f.op };
  }
}

/** A typed value from an input, or an error message. */
function parseValue(raw: string, family: FilterFamily): Param | { error: string } {
  const v = raw.trim();
  if (family === "number") {
    if (v === "") return { error: "Enter a number." };
    const n = Number(v);
    if (!Number.isFinite(n)) return { error: `"${v}" is not a number.` };
    // Keep big integers exact: DuckDB casts the text to the column's type.
    return Number.isInteger(n) && !Number.isSafeInteger(n) ? v : n;
  }
  if (family === "date") {
    if (v === "") return { error: "Enter a date." };
    return v;
  }
  return raw;
}

const isError = (v: Param | { error: string }): v is { error: string } =>
  typeof v === "object" && v !== null;

/** The filter the draft describes, or a message saying what's missing. */
export function toFilter(
  column: string,
  family: FilterFamily,
  d: Draft,
): { filter: Filter } | { error: string } {
  const not = canNegate(d.op) && d.not ? { not: true } : {};
  const done = (f: Filter) => ({ filter: { ...f, ...not } });
  switch (d.op) {
    case "contains":
    case "startsWith":
    case "endsWith":
      if (d.value === "") return { error: "Enter some text." };
      return done({
        column,
        op: d.op,
        value: d.value,
        caseSensitive: d.caseSensitive || undefined,
      });
    case "regex":
      if (d.value === "") return { error: "Enter a pattern." };
      return done({ column, op: "regex", pattern: d.value });
    case "equals":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const value = parseValue(d.value, family);
      if (isError(value)) return value;
      return done({ column, op: d.op, value });
    }
    case "range": {
      const hasMin = d.value.trim() !== "";
      const hasMax = d.value2.trim() !== "";
      if (!hasMin && !hasMax) return { error: "Enter a lower or upper bound (or both)." };
      const min = hasMin ? parseValue(d.value, family) : undefined;
      const max = hasMax ? parseValue(d.value2, family) : undefined;
      if (min !== undefined && isError(min)) return min;
      if (max !== undefined && isError(max)) return max;
      return done({ column, op: "range", ...(hasMin && { min }), ...(hasMax && { max }) });
    }
    case "lastDays": {
      const days = Number(d.days);
      if (!Number.isInteger(days) || days < 0) return { error: "Enter a whole number of days." };
      return done({ column, op: "lastDays", days });
    }
    case "in":
      if (d.selected.length === 0) return { error: "Pick at least one value." };
      return done({ column, op: "in", values: d.selected });
    case "isTrue":
    case "isFalse":
      return done({ column, op: "equals", value: d.op === "isTrue" });
    case "empty":
    case "isNull":
    case "notNull":
      return done({ column, op: d.op });
  }
}
