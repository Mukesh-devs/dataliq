import { quoteIdent } from "./copyAs";

/**
 * Data tools that need no SQL from the user: group by / pivot, value counts,
 * samples, appending and joining tabs, and a summary of every column. Each
 * builds one DuckDB query over a tab's table (as the SQL panel names it,
 * with the view's filters applied); the result opens as a new tab.
 */

/** Aggregates offered for measures. */
export type Agg =
  "count" | "countDistinct" | "sum" | "avg" | "min" | "max" | "median" | "p95" | "stddev";

export const AGGS: { agg: Agg; label: string; numeric: boolean }[] = [
  { agg: "count", label: "Count", numeric: false },
  { agg: "countDistinct", label: "Distinct count", numeric: false },
  { agg: "sum", label: "Sum", numeric: true },
  { agg: "avg", label: "Average", numeric: true },
  { agg: "min", label: "Min", numeric: false },
  { agg: "max", label: "Max", numeric: false },
  { agg: "median", label: "Median", numeric: true },
  { agg: "p95", label: "95th percentile", numeric: true },
  { agg: "stddev", label: "Standard deviation", numeric: true },
];

/** DuckDB number types (what sum, average and percentiles take). */
export function isNumericType(type: string): boolean {
  return /^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|FLOAT|DOUBLE|REAL|DECIMAL(\(.*\))?)$/i.test(
    type.trim(),
  );
}

export interface Measure {
  agg: Agg;
  /** Ignored for a row count (`count` without a column). */
  column?: string;
}

/** A measure's SQL expression; `count` without a column counts rows. */
export function measureExpr(m: Measure): string {
  if (!m.column) return "count(*)";
  const c = quoteIdent(m.column);
  switch (m.agg) {
    case "count":
      return `count(${c})`;
    case "countDistinct":
      return `count(DISTINCT ${c})`;
    case "median":
      return `median(${c})`;
    case "p95":
      return `quantile_cont(${c}, 0.95)`;
    case "stddev":
      return `stddev_samp(${c})`;
    default:
      return `${m.agg}(${c})`;
  }
}

/** A measure's result column name: `rows`, `sum_amount`, `p95_duration`. */
export function measureName(m: Measure): string {
  if (!m.column) return "rows";
  const prefix: Record<Agg, string> = {
    count: "count",
    countDistinct: "distinct",
    sum: "sum",
    avg: "avg",
    min: "min",
    max: "max",
    median: "median",
    p95: "p95",
    stddev: "stddev",
  };
  return `${prefix[m.agg]}_${m.column}`;
}

/** Names made unique by a numeric suffix, in order. */
function unique(names: string[], taken: Iterable<string> = []): string[] {
  const seen = new Set([...taken].map((n) => n.toLowerCase()));
  return names.map((name) => {
    let out = name;
    for (let i = 2; seen.has(out.toLowerCase()); i++) out = `${name}_${i}`;
    seen.add(out.toLowerCase());
    return out;
  });
}

export interface PivotSpec {
  /** Rows: one per combination of these columns. */
  groups: string[];
  measures: Measure[];
  /** Spread the measures across columns, one per value of this column. */
  pivotOn?: string;
}

/** `src` is a table name or a parenthesized query. */
export function pivotSql(src: string, spec: PivotSpec): string {
  const measures = spec.measures.length > 0 ? spec.measures : [{ agg: "count" as Agg }];
  const names = unique(measures.map(measureName), spec.groups);
  const groups = spec.groups.map(quoteIdent);
  if (spec.pivotOn) {
    const using = measures
      .map((m, i) => `${measureExpr(m)} AS ${quoteIdent(names[i]!)}`)
      .join(", ");
    const by = groups.length > 0 ? ` GROUP BY ${groups.join(", ")}` : "";
    const order = groups.length > 0 ? `\nORDER BY ${groups.join(", ")}` : "";
    return `SELECT * FROM (\n  PIVOT ${src} ON ${quoteIdent(spec.pivotOn)} USING ${using}${by}\n)${order}`;
  }
  const select = [
    ...groups,
    ...measures.map((m, i) => `${measureExpr(m)} AS ${quoteIdent(names[i]!)}`),
  ].join(", ");
  if (groups.length === 0) return `SELECT ${select}\nFROM ${src}`;
  return `SELECT ${select}\nFROM ${src}\nGROUP BY ${groups.join(", ")}\nORDER BY ${groups.join(", ")}`;
}

/** Each value of `column` with its count and share, most common first. */
export function valueCountsSql(src: string, column: string, limit?: number): string {
  const c = quoteIdent(column);
  const [count, percent] = unique(["count", "percent"], [column]).map(quoteIdent);
  return (
    `SELECT ${c}, count(*) AS ${count},\n` +
    `  round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS ${percent}\n` +
    `FROM ${src}\nGROUP BY ${c}\nORDER BY ${count} DESC, ${c} NULLS FIRST` +
    (limit ? `\nLIMIT ${Math.max(1, Math.floor(limit))}` : "")
  );
}

export type SampleSpec =
  | { method: "first"; rows: number }
  | { method: "rows"; rows: number; seed: number }
  | { method: "percent"; percent: number; seed: number };

/** A sample: the first rows, a fixed number of random rows, or a share of all rows. */
export function sampleSql(src: string, s: SampleSpec): string {
  const int = (n: number) => Math.max(1, Math.floor(n));
  switch (s.method) {
    case "first":
      return `SELECT * FROM ${src}\nLIMIT ${int(s.rows)}`;
    case "rows":
      return `SELECT * FROM ${src}\nUSING SAMPLE reservoir(${int(s.rows)} ROWS) REPEATABLE (${int(s.seed)})`;
    case "percent": {
      const p = Math.min(100, Math.max(0.0001, s.percent));
      return `SELECT * FROM ${src}\nUSING SAMPLE ${p} PERCENT (bernoulli, ${int(s.seed)})`;
    }
  }
}

/**
 * Tables stacked into one: columns matched by name (missing ones NULL),
 * optionally with a column saying which table each row came from.
 */
export function unionSql(parts: { src: string; label: string }[], sourceColumn?: string): string {
  return parts
    .map(({ src, label }) => {
      const tag = sourceColumn
        ? `'${label.replace(/'/g, "''")}' AS ${quoteIdent(sourceColumn)}, `
        : "";
      return `SELECT ${tag}* FROM ${src}`;
    })
    .join("\nUNION ALL BY NAME\n");
}

export type JoinKind = "inner" | "left" | "full" | "semi" | "anti";

export const JOIN_KINDS: { kind: JoinKind; label: string; help: string }[] = [
  { kind: "inner", label: "Matching rows", help: "Rows with a match on both sides" },
  {
    kind: "left",
    label: "All left rows",
    help: "Every left row, with the right columns when matched",
  },
  { kind: "full", label: "All rows", help: "Every row of both, matched where possible" },
  { kind: "semi", label: "Left rows with a match", help: "Left rows only, those that match" },
  { kind: "anti", label: "Left rows without a match", help: "Left rows that have no match" },
];

export interface JoinSpec {
  kind: JoinKind;
  /** Pairs of key columns: left column = right column. */
  keys: { left: string; right: string }[];
  leftColumns: string[];
  rightColumns: string[];
}

/**
 * Joins two tables. Right columns that clash with a left one get a
 * `_right` suffix; inner and left joins leave out the right keys (they
 * equal the left ones).
 */
export function joinSql(left: string, right: string, spec: JoinSpec): string {
  if (spec.keys.length === 0) throw new Error("Choose at least one pair of key columns.");
  const on = spec.keys
    .map((k) => `l.${quoteIdent(k.left)} = r.${quoteIdent(k.right)}`)
    .join(" AND ");
  if (spec.kind === "semi" || spec.kind === "anti") {
    return `SELECT l.*\nFROM ${left} AS l\n${spec.kind.toUpperCase()} JOIN ${right} AS r ON ${on}`;
  }
  const rightKeys = new Set(spec.keys.map((k) => k.right));
  const rightCols =
    spec.kind === "full" ? spec.rightColumns : spec.rightColumns.filter((c) => !rightKeys.has(c));
  const taken = new Set(spec.leftColumns.map((c) => c.toLowerCase()));
  const names = unique(
    rightCols.map((c) => (taken.has(c.toLowerCase()) ? `${c}_right` : c)),
    spec.leftColumns,
  );
  const select = [
    ...spec.leftColumns.map((c) => `l.${quoteIdent(c)}`),
    ...rightCols.map((c, i) =>
      names[i] === c ? `r.${quoteIdent(c)}` : `r.${quoteIdent(c)} AS ${quoteIdent(names[i]!)}`,
    ),
  ];
  const kind = { inner: "JOIN", left: "LEFT JOIN", full: "FULL JOIN" }[spec.kind];
  return `SELECT ${select.join(", ")}\nFROM ${left} AS l\n${kind} ${right} AS r ON ${on}`;
}

/** One row per column: type, min, max, distinct (estimate), mean, quartiles, count, null %. */
export function summarySql(src: string): string {
  return `SELECT * FROM (SUMMARIZE SELECT * FROM ${src})`;
}

/** A query (e.g. a view as SQL) as a FROM item. */
export function asSource(sql: string): string {
  return `(\n${sql.trim().replace(/;\s*$/, "")}\n)`;
}
