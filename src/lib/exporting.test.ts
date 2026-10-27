import { describe, expect, it } from "vitest";
import { defaultExportName, rangeRows, toRanges } from "./exporting";

describe("exporting helpers", () => {
  it("merges selected rows into ranges", () => {
    expect(toRanges([])).toEqual([]);
    expect(toRanges([0, 1, 2, 5, 7, 8])).toEqual([
      [0, 3],
      [5, 6],
      [7, 9],
    ]);
    expect(rangeRows(toRanges([0, 1, 2, 5, 7, 8]))).toBe(6);
  });

  it("suggests a name that is never the open file's", () => {
    expect(defaultExportName("sales.csv.gz", "parquet")).toBe("sales-export.parquet");
    expect(defaultExportName("sales.csv", "csv")).toBe("sales-export.csv");
    expect(defaultExportName("Q1 report.xlsx", "csvGz")).toBe("Q1 report-export.csv.gz");
    expect(defaultExportName("a/b:c", "json")).toBe("a_b_c-export.json");
    expect(defaultExportName("", "xlsx")).toBe("export-export.xlsx");
  });
});
