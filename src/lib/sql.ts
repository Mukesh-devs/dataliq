import type { DatasetInfo } from "./files";
import { call } from "./ipc";

/** One statement of a SQL script and where it starts in the script. */
export interface Statement {
  text: string;
  from: number;
}

/**
 * Splits a script at `;` outside strings, quoted identifiers, `$$` blocks
 * and comments. Empty statements (only blanks or comments) are dropped;
 * each statement's text is trimmed and `from` points at its first character.
 */
export function splitStatements(script: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  let meaningful = false;
  const push = (end: number) => {
    const raw = script.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    if (meaningful) out.push({ text: raw.trim(), from: start + lead });
    meaningful = false;
  };
  while (i < script.length) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (ch === "-" && next === "-") {
      const nl = script.indexOf("\n", i);
      i = nl < 0 ? script.length : nl + 1;
    } else if (ch === "/" && next === "*") {
      const end = script.indexOf("*/", i + 2);
      i = end < 0 ? script.length : end + 2;
    } else if (ch === "'" || ch === '"') {
      meaningful = true;
      // A doubled quote stays inside the string.
      let j = i + 1;
      for (;;) {
        const k = script.indexOf(ch, j);
        if (k < 0) {
          j = script.length;
          break;
        }
        if (script[k + 1] === ch) j = k + 2;
        else {
          j = k + 1;
          break;
        }
      }
      i = j;
    } else if (ch === "$" && next === "$") {
      meaningful = true;
      const end = script.indexOf("$$", i + 2);
      i = end < 0 ? script.length : end + 2;
    } else if (ch === ";") {
      push(i);
      i += 1;
      start = i;
    } else {
      if (!/\s/.test(ch)) meaningful = true;
      i += 1;
    }
  }
  push(script.length);
  return out;
}

/**
 * Where DuckDB says an error is, as an offset into `sql`: from the
 * "LINE n: <context>" line and the caret under it. Long lines are shown
 * shortened with "..." around the context, which is found in the line.
 */
export function errorOffset(message: string, sql: string): number | null {
  const m = /\nLINE (\d+): (.*)\n( *)\^/.exec(message);
  if (!m) return null;
  const lineNo = Number(m[1]);
  let context = m[2]!;
  let caret = m[3]!.length - `LINE ${m[1]}: `.length;
  const lines = sql.split("\n");
  const line = lines[lineNo - 1];
  if (line === undefined || caret < 0) return null;
  let column = caret;
  if (context.startsWith("...")) {
    context = context.slice(3);
    caret -= 3;
    const snippet = context.endsWith("...") ? context.slice(0, -3) : context;
    const at = line.indexOf(snippet);
    if (at < 0) return null;
    column = at + caret;
  }
  let offset = 0;
  for (let i = 0; i < lineNo - 1; i++) offset += lines[i]!.length + 1;
  return offset + Math.min(column, line.length);
}

/** The error message without DuckDB's "LINE n:" context (shown in the editor instead). */
export function errorText(message: string): string {
  return message.replace(/\n+LINE \d+: .*\n *\^\s*$/, "").trim();
}

/**
 * A clean SQL table name from a file name: "Sales 2024 (final).csv.gz" ->
 * "sales_2024_final". Lower case letters, digits and underscores, not
 * starting with a digit.
 */
export function cleanTableName(fileName: string): string {
  const base = fileName
    .replace(/(\.(gz|zst|zstd|bz2))?$/i, "")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "data";
  return /^[0-9]/.test(base) ? `t_${base}` : base;
}

/** The table that always holds the active tab's view (filters, search, sort). */
export const CURRENT_VIEW = "current_view";

/**
 * Why `name` can't be a table name, or null if it can: letters, digits and
 * underscores, not starting with a digit, not taken by another table.
 */
export function tableNameProblem(name: string, taken: string[]): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    return "Use letters, digits and underscores, not starting with a digit.";
  const lower = name.toLowerCase();
  if (lower === CURRENT_VIEW) return `"${CURRENT_VIEW}" is the active tab's view.`;
  if (taken.some((t) => t.toLowerCase() === lower)) return `Another file is already "${name}".`;
  return null;
}

/**
 * Makes names unique in order, also against `taken` (compared ignoring
 * case, as SQL does): the second "sales" becomes "sales_2".
 */
export function uniqueNames(names: string[], taken: string[] = []): string[] {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  return names.map((name) => {
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name}_${n}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export function registerTable(datasetId: string, name: string): Promise<void> {
  return call("register_table", { datasetId, name });
}

export function unregisterTable(name: string): Promise<void> {
  return call("unregister_table", { name });
}

/**
 * Whether a statement gives rows worth keeping as a result (a query), as
 * opposed to CREATE, INSERT, SET … Leading comments and parentheses are
 * skipped. EXPLAIN and PRAGMA rows are shown as they come.
 */
export function returnsRows(statement: string): boolean {
  const head = statement
    .replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/|\()*/, "")
    .slice(0, 16)
    .toUpperCase();
  return /^(SELECT|WITH|FROM|VALUES|TABLE|DESCRIBE|SHOW|SUMMARIZE|PIVOT|UNPIVOT)\b/.test(head);
}

/** Runs a query in the panel's session; its rows become a pageable dataset. */
export function sqlResult(sql: string, requestId: string): Promise<DatasetInfo> {
  return call("sql_result", { sql, requestId });
}
