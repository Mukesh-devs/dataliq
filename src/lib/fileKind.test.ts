import { describe, expect, it } from "vitest";
import { fileKind } from "./fileKind";

describe("fileKind", () => {
  it("uses the format the app found, once the file is open", () => {
    expect(fileKind({ title: "a", info: { format: "xlsx" } })).toBe("excel");
    expect(fileKind({ title: "a", info: { format: "tsv" } })).toBe("csv");
    expect(fileKind({ title: "a", info: { format: "ndjson" } })).toBe("json");
    expect(fileKind({ title: "a", info: { format: "parquet" } })).toBe("parquet");
    expect(fileKind({ title: "a", info: { format: "duckdb" } })).toBe("database");
    expect(fileKind({ title: "q", info: { format: "sql" } })).toBe("sql");
  });

  it("uses the name's extension while it's opening, under any compression", () => {
    expect(fileKind({ title: "Master.csv", path: "/d/Master.csv" })).toBe("csv");
    expect(fileKind({ title: "x", path: "C:\\data\\orders_2025.csv.gz" })).toBe("csv");
    expect(fileKind({ title: "Report.XLSX", path: "/d/Report.XLSX" })).toBe("excel");
    expect(fileKind({ title: "logs.jsonl.zst", path: "/d/logs.jsonl.zst" })).toBe("json");
    expect(fileKind({ title: "folder", path: "/d/folder" })).toBe("table");
  });

  it("marks folders, URLs and comparisons", () => {
    expect(
      fileKind({
        title: "f",
        path: "/d/*.csv",
        info: { format: "csv", files: { count: 3 } as never },
      }),
    ).toBe("folder");
    expect(fileKind({ title: "t", path: "https://example.org/t.csv" })).toBe("url");
    expect(
      fileKind({ title: "s3", path: "s3://bucket/t.parquet", info: { format: "parquet" } }),
    ).toBe("url");
    expect(fileKind({ title: "a ↔ b", compare: {}, info: { format: "csv" } })).toBe("compare");
  });
});
