import type { ColumnMeta, DatasetInfo } from "./files";
import { call } from "./ipc";
import { describeFilter, type Filter, type ViewSpec } from "./view";

/** Target of a change-type step; mirrors `NewType` in src-tauri/src/recipe/mod.rs. */
export type NewType = "integer" | "number" | "text" | "date" | "timestamp" | "boolean";
export type Case = "upper" | "lower" | "title";

/** One cleaning step; mirrors `Step` in Rust. */
export type Step =
  | { op: "rename"; column: string; to: string }
  | { op: "changeType"; column: string; to: NewType; format?: string }
  | { op: "trim"; column: string }
  | { op: "changeCase"; column: string; case: Case }
  | {
      op: "replace";
      column: string;
      find: string;
      replace: string;
      regex?: boolean;
      caseSensitive?: boolean;
    }
  | { op: "split"; column: string; delimiter: string; into: string[]; keep?: boolean }
  | { op: "fillEmpty"; column: string; value: string }
  | { op: "removeDuplicates"; columns?: string[] }
  | { op: "removeRows"; filter: Filter }
  | { op: "calculate"; name: string; expression: string };

export type StepOp = Step["op"];

/** A step and whether it runs. */
export type RecipeStep = Step & { enabled?: boolean };

export interface StepOutcome {
  /** What went wrong; the steps after it were not applied. */
  error: string | null;
  /** Change type: values that couldn't be converted (now empty). */
  failed: number | null;
  /** Not applied: turned off, or after a failing step. */
  skipped: boolean;
}

export interface RecipeOutcome {
  /** The cleaned rows (every step up to the first that failed). */
  dataset: DatasetInfo;
  columns: ColumnMeta[];
  steps: StepOutcome[];
  elapsedMs: number;
}

/** Applies the steps to a dataset: a new dataset (close it when replaced). */
export function applyRecipe(
  datasetId: string,
  steps: RecipeStep[],
  requestId?: string,
  group?: string,
): Promise<RecipeOutcome> {
  return call("apply_recipe", { datasetId, steps, requestId, group });
}

/** The recipe as one DuckDB script over `reader` (the file's reader call). */
export function recipeScript(
  datasetId: string,
  steps: RecipeStep[],
  reader: string,
): Promise<string> {
  return call("recipe_script", { datasetId, steps, reader });
}

export const isEnabled = (s: RecipeStep) => s.enabled !== false;

/** The steps that change anything (an empty recipe leaves the file as it is). */
export const hasEffect = (steps: RecipeStep[] | undefined) => !!steps?.some(isEnabled);

export const STEP_NAMES: Record<StepOp, string> = {
  rename: "Rename column",
  changeType: "Change type",
  trim: "Trim spaces",
  changeCase: "Change case",
  replace: "Find and replace",
  split: "Split column",
  fillEmpty: "Fill empty cells",
  removeDuplicates: "Remove duplicate rows",
  removeRows: "Remove rows",
  calculate: "Calculated column",
};

export const TYPE_NAMES: Record<NewType, string> = {
  integer: "whole number",
  number: "number",
  text: "text",
  date: "date",
  timestamp: "date and time",
  boolean: "true/false",
};

const CASE_NAMES: Record<Case, string> = {
  upper: "UPPER CASE",
  lower: "lower case",
  title: "Title Case",
};

const q = (s: string) => `“${s}”`;

/** One line saying what a step does, e.g. `Trim spaces in “name”`. */
export function describeStep(s: Step): string {
  switch (s.op) {
    case "rename":
      return `Rename ${q(s.column)} to ${q(s.to)}`;
    case "changeType":
      return `Change ${q(s.column)} to ${TYPE_NAMES[s.to]}${s.format ? ` (${s.format})` : ""}`;
    case "trim":
      return `Trim spaces in ${q(s.column)}`;
    case "changeCase":
      return `${q(s.column)} in ${CASE_NAMES[s.case]}`;
    case "replace":
      return `Replace ${s.regex ? "pattern " : ""}${q(s.find)} with ${q(s.replace)} in ${q(s.column)}`;
    case "split":
      return `Split ${q(s.column)} at ${q(s.delimiter)} into ${s.into.map(q).join(", ")}`;
    case "fillEmpty":
      return `Fill empty ${q(s.column)} with ${q(s.value)}`;
    case "removeDuplicates":
      return s.columns?.length
        ? `Remove duplicates by ${s.columns.map(q).join(", ")}`
        : "Remove duplicate rows";
    case "removeRows":
      return `Remove rows where ${describeFilter(s.filter)}`;
    case "calculate":
      return `New column ${q(s.name)} = ${s.expression}`;
  }
}

/** The view without filters, sort keys and columns that the recipe removed. */
export function fitView(view: ViewSpec | undefined, columns: string[]): ViewSpec | undefined {
  if (!view) return view;
  const has = new Set(columns);
  const filters = view.filters?.filter((f) => has.has(f.column));
  const sort = view.sort?.filter((k) => has.has(k.column));
  const cols = view.columns?.filter((c) => has.has(c));
  if (
    filters?.length === view.filters?.length &&
    sort?.length === view.sort?.length &&
    cols?.length === view.columns?.length
  )
    return view;
  return { ...view, filters, sort, columns: cols };
}

/**
 * The steps up to the first that failed: what the cleaned rows are made
 * of (and so what a script of them must contain).
 */
export function appliedSteps(steps: RecipeStep[], outcomes: StepOutcome[]): RecipeStep[] {
  const failed = outcomes.findIndex((o) => o.error);
  return failed < 0 ? steps : steps.slice(0, failed);
}
