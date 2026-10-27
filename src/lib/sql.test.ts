import { describe, expect, it } from "vitest";
import {
  cleanTableName,
  errorOffset,
  errorText,
  returnsRows,
  splitStatements,
  tableNameProblem,
  uniqueNames,
} from "./sql";

describe("splitStatements", () => {
  it("splits at semicolons outside strings, identifiers and comments", () => {
    const script = [
      "SELECT 'a;b' AS \"x;y\"; -- note; here",
      "/* block; comment */ SELECT 2;",
      "  ;",
      "SELECT 'it''s; fine'",
    ].join("\n");
    expect(splitStatements(script)).toEqual([
      { text: "SELECT 'a;b' AS \"x;y\"", from: 0 },
      { text: "-- note; here\n/* block; comment */ SELECT 2", from: 23 },
      { text: "SELECT 'it''s; fine'", from: script.indexOf("SELECT 'it") },
    ]);
  });

  it("drops statements that are only comments or blanks", () => {
    expect(splitStatements("-- just a comment\n;  ;\n")).toEqual([]);
    expect(splitStatements("")).toEqual([]);
  });

  it("keeps $$ blocks whole", () => {
    expect(splitStatements("SELECT $$a;b$$; SELECT 1").map((s) => s.text)).toEqual([
      "SELECT $$a;b$$",
      "SELECT 1",
    ]);
  });
});

describe("errorOffset", () => {
  it("reads DuckDB's line and caret", () => {
    const sql = "SELECT a,\n  nope FROM t";
    const message =
      'Binder Error: Referenced column "nope" not found in FROM clause!\nCandidate bindings: "a"\n\nLINE 2:   nope FROM t\n          ^';
    expect(errorOffset(message, sql)).toBe(sql.indexOf("nope"));
    expect(errorText(message)).toBe(
      'Binder Error: Referenced column "nope" not found in FROM clause!\nCandidate bindings: "a"',
    );
  });

  it("finds shortened long lines", () => {
    const sql = `SELECT ${"x, ".repeat(60)}nope FROM t`;
    const context = "...x, x, x, nope FROM t";
    const caret = " ".repeat("LINE 1: ".length + context.indexOf("nope"));
    const message = `Binder Error: Referenced column "nope" not found\n\nLINE 1: ${context}\n${caret}^`;
    expect(errorOffset(message, sql)).toBe(sql.indexOf("nope"));
  });

  it("returns null without a position", () => {
    expect(errorOffset("Parser Error: syntax error at end of input", "SELECT")).toBeNull();
  });
});

describe("table names", () => {
  it("cleans file names", () => {
    expect(cleanTableName("Sales 2024 (final).csv.gz")).toBe("sales_2024_final");
    expect(cleanTableName("Ünïcode Café.parquet")).toBe("unicode_cafe");
    expect(cleanTableName("2024.csv")).toBe("t_2024");
    expect(cleanTableName("東京.csv")).toBe("data");
  });

  it("checks chosen names", () => {
    expect(tableNameProblem("sales_2024", ["people"])).toBeNull();
    expect(tableNameProblem("2024", [])).toMatch(/letters, digits/);
    expect(tableNameProblem("my table", [])).toMatch(/letters, digits/);
    expect(tableNameProblem("People", ["people"])).toMatch(/already/);
    expect(tableNameProblem("Current_View", [])).toMatch(/active tab/);
    expect(uniqueNames(["a", "a"], ["A"])).toEqual(["a_2", "a_3"]);
  });

  it("makes them unique in order", () => {
    expect(uniqueNames(["sales", "sales", "people", "sales"])).toEqual([
      "sales",
      "sales_2",
      "people",
      "sales_3",
    ]);
  });
});

describe("returnsRows", () => {
  it("tells queries from other statements", () => {
    for (const q of [
      "SELECT 1",
      "  with t as (select 1) select * from t",
      "FROM people",
      "-- top ones\nSELECT * FROM t",
      "/* x */ (SELECT 1) UNION (SELECT 2)",
      "DESCRIBE people",
      "SUMMARIZE people",
      "values (1), (2)",
    ])
      expect(returnsRows(q), q).toBe(true);
    for (const q of [
      "CREATE TABLE t AS SELECT 1",
      "INSERT INTO t SELECT 1",
      "SET threads = 2",
      "EXPLAIN SELECT 1",
      "PRAGMA version",
      "selection_fn()",
    ])
      expect(returnsRows(q), q).toBe(false);
  });
});
