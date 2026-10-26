import {
  Bool,
  DateDay,
  Field,
  Float64,
  Int32,
  List,
  Struct,
  TimestampMicrosecond,
  Utf8,
  tableFromArrays,
  tableToIPC,
} from "apache-arrow";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cellValue, columnKind, decodeIpc, describeColumns } from "./arrow";

describe("columnKind", () => {
  it("maps Arrow types to display kinds", () => {
    expect(columnKind(new Int32())).toBe("integer");
    expect(columnKind(new Float64())).toBe("number");
    expect(columnKind(new Utf8())).toBe("text");
    expect(columnKind(new Bool())).toBe("boolean");
    expect(columnKind(new DateDay())).toBe("date");
    expect(columnKind(new TimestampMicrosecond())).toBe("timestamp");
    expect(columnKind(new List(new Field("item", new Int32())))).toBe("json");
    expect(columnKind(new Struct([new Field("a", new Utf8())]))).toBe("json");
  });
});

describe("decodeIpc", () => {
  it("round-trips a table encoded by apache-arrow", () => {
    const table = tableFromArrays({ id: Int32Array.from([1, 2, 3]), name: ["a", "b", "c"] });
    const decoded = decodeIpc(tableToIPC(table, "stream"));
    expect(decoded.numRows).toBe(3);
    expect(cellValue(decoded, 2, 1)).toBe("c");
  });

  // Bytes written by the Rust integration test `engine_query` from a known
  // DuckDB query, so this checks the real Rust -> JS wire format.
  it("decodes the IPC bytes produced by the Rust engine", () => {
    const bytes = readFileSync(resolve(process.cwd(), "fixtures/ipc/known_query.arrows"));
    const table = decodeIpc(bytes);
    expect(table.numRows).toBe(3);
    expect(describeColumns(table).map((c) => [c.name, c.kind])).toEqual([
      ["id", "integer"],
      ["name", "text"],
      ["amount", "number"],
      ["flag", "boolean"],
      ["day", "date"],
      ["ts", "timestamp"],
      ["tags", "json"],
    ]);
    expect(cellValue(table, 0, 0)).toBe(1n);
    expect(cellValue(table, 1, 1)).toBe("béta");
    expect(cellValue(table, 2, 1)).toBeNull();
    expect(cellValue(table, 0, 2)).toBe(1.5);
    expect(cellValue(table, 1, 3)).toBe(false);
    // DateDay decodes to epoch milliseconds.
    expect(new Date(cellValue(table, 0, 4) as number).toISOString()).toBe(
      "2024-01-31T00:00:00.000Z",
    );
    expect(cellValue(table, 2, 4)).toBeNull();
  });
});
