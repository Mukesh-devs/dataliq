import { describe, expect, it } from "vitest";
import {
  asSource,
  isNumericType,
  joinSql,
  measureExpr,
  measureName,
  pivotSql,
  sampleSql,
  summarySql,
  unionSql,
  valueCountsSql,
} from "./tools";

describe("data tool SQL", () => {
  it("names and computes measures", () => {
    expect(measureExpr({ agg: "count" })).toBe("count(*)");
    expect(measureName({ agg: "count" })).toBe("rows");
    expect(measureExpr({ agg: "p95", column: "dur" })).toBe('quantile_cont("dur", 0.95)');
    expect(measureExpr({ agg: "countDistinct", column: "a b" })).toBe('count(DISTINCT "a b")');
    expect(measureName({ agg: "avg", column: "amount" })).toBe("avg_amount");
  });

  it("groups by columns with measures", () => {
    expect(
      pivotSql('"calls"', {
        groups: ["account", "day"],
        measures: [{ agg: "count" }, { agg: "sum", column: "minutes" }],
      }),
    ).toBe(
      'SELECT "account", "day", count(*) AS "rows", sum("minutes") AS "sum_minutes"\n' +
        'FROM "calls"\nGROUP BY "account", "day"\nORDER BY "account", "day"',
    );
    // No groups: one row of totals; no measures: a row count.
    expect(pivotSql("t", { groups: [], measures: [] })).toBe('SELECT count(*) AS "rows"\nFROM t');
    // A measure named like a group column is renamed.
    expect(pivotSql("t", { groups: ["rows"], measures: [] })).toContain('AS "rows_2"');
  });

  it("pivots a column's values into columns", () => {
    expect(
      pivotSql("t", {
        groups: ["account"],
        measures: [{ agg: "sum", column: "m" }],
        pivotOn: "type",
      }),
    ).toBe(
      'SELECT * FROM (\n  PIVOT t ON "type" USING sum("m") AS "sum_m" GROUP BY "account"\n)\nORDER BY "account"',
    );
  });

  it("counts values", () => {
    expect(valueCountsSql("t", "city", 50)).toBe(
      'SELECT "city", count(*) AS "count",\n' +
        '  round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS "percent"\n' +
        'FROM t\nGROUP BY "city"\nORDER BY "count" DESC, "city" NULLS FIRST\nLIMIT 50',
    );
    expect(valueCountsSql("t", "count")).toContain('count(*) AS "count_2"');
  });

  it("samples", () => {
    expect(sampleSql("t", { method: "first", rows: 1000 })).toBe("SELECT * FROM t\nLIMIT 1000");
    expect(sampleSql("t", { method: "rows", rows: 500.7, seed: 7 })).toBe(
      "SELECT * FROM t\nUSING SAMPLE reservoir(500 ROWS) REPEATABLE (7)",
    );
    expect(sampleSql("t", { method: "percent", percent: 150, seed: 1 })).toContain(
      "USING SAMPLE 100 PERCENT (bernoulli, 1)",
    );
  });

  it("appends tables by column name", () => {
    expect(
      unionSql(
        [
          { src: "a", label: "jan" },
          { src: "b", label: "o'feb" },
        ],
        "source",
      ),
    ).toBe(
      "SELECT 'jan' AS \"source\", * FROM a\nUNION ALL BY NAME\nSELECT 'o''feb' AS \"source\", * FROM b",
    );
    expect(
      unionSql([
        { src: "a", label: "a" },
        { src: "b", label: "b" },
      ]),
    ).toBe("SELECT * FROM a\nUNION ALL BY NAME\nSELECT * FROM b");
  });

  it("joins, renaming clashing right columns", () => {
    const spec = {
      keys: [{ left: "id", right: "customer_id" }],
      leftColumns: ["id", "name"],
      rightColumns: ["customer_id", "name", "total"],
    };
    expect(joinSql("a", "b", { ...spec, kind: "left" })).toBe(
      'SELECT l."id", l."name", r."name" AS "name_right", r."total"\n' +
        'FROM a AS l\nLEFT JOIN b AS r ON l."id" = r."customer_id"',
    );
    expect(joinSql("a", "b", { ...spec, kind: "full" })).toContain('r."customer_id", r."name" AS');
    expect(joinSql("a", "b", { ...spec, kind: "anti" })).toBe(
      'SELECT l.*\nFROM a AS l\nANTI JOIN b AS r ON l."id" = r."customer_id"',
    );
    expect(() => joinSql("a", "b", { ...spec, keys: [], kind: "inner" })).toThrow();
  });

  it("summarizes and wraps queries", () => {
    expect(summarySql("t")).toBe("SELECT * FROM (SUMMARIZE SELECT * FROM t)");
    expect(asSource("SELECT 1;\n")).toBe("(\nSELECT 1\n)");
  });

  it("knows DuckDB number types", () => {
    for (const t of ["INTEGER", "BIGINT", "UTINYINT", "DOUBLE", "DECIMAL(18,3)", "hugeint"])
      expect(isNumericType(t)).toBe(true);
    for (const t of ["VARCHAR", "DATE", "TIMESTAMP", "BOOLEAN", "INTERVAL", "INTEGER[]"])
      expect(isNumericType(t)).toBe(false);
  });
});
