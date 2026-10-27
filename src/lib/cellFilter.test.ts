import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "./arrow";
import { filterForValue } from "./cellFilter";

const col = (kind: ColumnInfo["kind"], extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name: "c",
  kind,
  type: "x",
  nullable: true,
  ...extra,
});

describe("filterForValue", () => {
  it("filters on typed values", () => {
    expect(filterForValue(col("integer"), 42n, false)).toEqual({
      column: "c",
      op: "equals",
      value: 42,
    });
    expect(filterForValue(col("number"), 9.5, true)).toEqual({
      column: "c",
      op: "equals",
      value: 9.5,
      not: true,
    });
    expect(filterForValue(col("boolean"), false, false)).toEqual({
      column: "c",
      op: "equals",
      value: false,
    });
    expect(filterForValue(col("date"), 19_737 * 86_400_000, false)).toEqual({
      column: "c",
      op: "equals",
      value: "2024-01-15",
    });
    expect(filterForValue(col("text"), "", false)).toEqual({
      column: "c",
      op: "equals",
      value: "",
    });
  });

  it("keeps big integers and long decimals exact", () => {
    expect(filterForValue(col("integer"), 9_007_199_254_740_993n, false)).toMatchObject({
      value: "9007199254740993",
    });
    const decimal = { toString: () => "1250" };
    expect(filterForValue(col("number", { scale: 2 }), decimal, false)).toMatchObject({
      value: "12.50",
    });
  });

  it("uses null tests for NULL cells and skips nested values", () => {
    expect(filterForValue(col("text"), null, false)).toEqual({ column: "c", op: "isNull" });
    expect(filterForValue(col("text"), null, true)).toEqual({ column: "c", op: "notNull" });
    expect(filterForValue(col("json"), "{}", false)).toBeNull();
  });
});
