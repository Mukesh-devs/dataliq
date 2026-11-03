import type { ColumnKind, ValueFormat } from "./arrow";
import { formatValue } from "./format";

/**
 * Conditional formatting: cells filled by rules ("> 300" in red) or by a
 * colour scale over a number column's range. A display choice kept with
 * the column layout; filters and data are untouched.
 */

export type RuleColor = "red" | "amber" | "green" | "blue" | "purple";
export const RULE_COLORS: RuleColor[] = ["red", "amber", "green", "blue", "purple"];

export type RuleOp = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "contains" | "empty";

export const RULE_OPS: { op: RuleOp; label: string; numeric?: boolean; noValue?: boolean }[] = [
  { op: "gt", label: "greater than", numeric: true },
  { op: "gte", label: "at least", numeric: true },
  { op: "lt", label: "less than", numeric: true },
  { op: "lte", label: "at most", numeric: true },
  { op: "eq", label: "equal to" },
  { op: "neq", label: "not equal to" },
  { op: "contains", label: "containing" },
  { op: "empty", label: "empty", noValue: true },
];

export interface CellRule {
  op: RuleOp;
  /** The number or text compared with (none for "empty"). */
  value?: string;
  color: RuleColor;
}

export interface ColorScale {
  /** The column's range when the scale was made (low end light, high end strong). */
  min: number;
  max: number;
  color: RuleColor;
}

export interface ColumnFormat {
  /** The first matching rule fills the cell. */
  rules?: CellRule[];
  /** Numbers only; rules win over it. */
  scale?: ColorScale;
}

/** How a cell is filled: a rule's colour, or a colour at a strength in [0, 1]. */
export type CellFill = { color: RuleColor; strength?: number };

const isNumber = (kind: ColumnKind) => kind === "integer" || kind === "number";

/** A number cell as a JS number (bigints and decimals too). */
function asNumber(value: unknown, format: ValueFormat): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const n = Number(formatValue(value, format));
  return Number.isFinite(n) ? n : null;
}

/** Whether `rule` matches a cell. Numbers compare as numbers, the rest as text (any case). */
export function ruleMatches(rule: CellRule, value: unknown, format: ValueFormat): boolean {
  const text = value === null || value === undefined ? null : formatValue(value, format);
  if (rule.op === "empty") return text === null || text === "";
  if (text === null) return false;
  const target = (rule.value ?? "").trim();
  const numeric = isNumber(format.kind);
  const n = numeric ? asNumber(value, format) : null;
  const t = Number(target);
  switch (rule.op) {
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      // Numbers by value; dates and text by their text (ISO dates sort right).
      const cmp =
        n !== null && target !== "" && Number.isFinite(t)
          ? n - t
          : text.localeCompare(target, undefined, { numeric: true });
      return rule.op === "gt"
        ? cmp > 0
        : rule.op === "gte"
          ? cmp >= 0
          : rule.op === "lt"
            ? cmp < 0
            : cmp <= 0;
    }
    case "eq":
    case "neq": {
      const equal =
        n !== null && target !== "" && Number.isFinite(t)
          ? n === t
          : text.toLowerCase() === target.toLowerCase();
      return rule.op === "eq" ? equal : !equal;
    }
    case "contains":
      return target !== "" && text.toLowerCase().includes(target.toLowerCase());
  }
}

/** The fill of a cell under `format`, if any. */
export function cellFill(
  format: ColumnFormat | undefined,
  value: unknown,
  column: ValueFormat,
): CellFill | undefined {
  if (!format) return undefined;
  for (const rule of format.rules ?? []) {
    if (ruleMatches(rule, value, column)) return { color: rule.color };
  }
  const scale = format.scale;
  if (scale && isNumber(column.kind)) {
    const n = asNumber(value, column);
    if (n === null) return undefined;
    const span = scale.max - scale.min;
    const t = span > 0 ? (n - scale.min) / span : 1;
    return { color: scale.color, strength: Math.min(1, Math.max(0, t)) };
  }
  return undefined;
}

/** Whether a format does anything. */
export function hasFormat(format: ColumnFormat | undefined): boolean {
  return !!format && ((format.rules?.length ?? 0) > 0 || !!format.scale);
}

/** "> 300", "containing “fail”", "empty": a rule in a few words. */
export function describeRule(rule: CellRule): string {
  const label = RULE_OPS.find((o) => o.op === rule.op)?.label ?? rule.op;
  return rule.op === "empty" ? label : `${label} ${rule.value ?? ""}`.trim();
}
