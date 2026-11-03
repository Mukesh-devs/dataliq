import { describe, expect, it } from "vitest";
import { connectionName, openTableSql } from "./connect";

describe("live database helpers", () => {
  it("makes a SQL name from a database name", () => {
    expect(connectionName("cdr")).toBe("cdr");
    expect(connectionName(" CDR Prod-2024 ")).toBe("cdr_prod_2024");
    expect(connectionName("2024_calls")).toBe("db_2024_calls");
    expect(connectionName("")).toBe("db");
  });

  it("opens a table with a row limit or whole", () => {
    const t = { schema: "public", name: "call log", kind: "BASE TABLE" };
    expect(openTableSql("cdr", t, 100_000)).toBe(
      'SELECT * FROM "cdr"."public"."call log"\nLIMIT 100000',
    );
    expect(openTableSql("cdr", t)).toBe('SELECT * FROM "cdr"."public"."call log"');
  });
});
