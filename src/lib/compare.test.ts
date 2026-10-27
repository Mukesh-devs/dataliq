import { describe, expect, it } from "vitest";
import {
  commonColumns,
  compareNotes,
  isChangedCell,
  suggestKeys,
  type Comparison,
} from "./compare";

const col = (name: string, type = "VARCHAR") => ({ name, type });

const base: Comparison = {
  dataset: { id: "diff-1", rowCount: 7 },
  columns: [],
  leftRows: 7,
  rightRows: 8,
  added: 2,
  removed: 1,
  changed: 4,
  same: 2,
  duplicateLeft: 0,
  duplicateRight: 0,
  compared: ["name"],
  onlyLeft: [],
  onlyRight: [],
  retyped: [],
  changes: [],
  elapsedMs: 5,
};

describe("comparisons", () => {
  it("suggests a key column both files have", () => {
    const left = [col("name"), col("order_id"), col("amount")];
    const right = [col("amount"), col("order_id"), col("name")];
    expect(commonColumns(left, right)).toEqual(["name", "order_id", "amount"]);
    expect(suggestKeys(left, right)).toEqual(["order_id"]);
    expect(suggestKeys([col("id"), col("x")], [col("x"), col("id")])).toEqual(["id"]);
    // Nothing key-like: the first common column.
    expect(suggestKeys([col("a"), col("b")], [col("b")])).toEqual(["b"]);
    expect(suggestKeys([col("a")], [col("b")])).toEqual([]);
  });

  it("says what could not be matched one to one", () => {
    expect(compareNotes(base)).toEqual([]);
    expect(
      compareNotes({
        ...base,
        duplicateLeft: 2,
        duplicateRight: 3,
        retyped: [{ name: "qty", left: "BIGINT", right: "VARCHAR" }],
        onlyLeft: ["note"],
        onlyRight: ["city", "joined"],
      }),
    ).toEqual([
      "Repeated keys (2 rows before, 3 rows after) are matched in order of appearance.",
      "“qty” is BIGINT before and VARCHAR after: compared as text.",
      "Only before: “note” (not compared).",
      "Only after: “city”, “joined” (not compared).",
    ]);
  });

  it("marks changed cells and their old values", () => {
    expect(isChangedCell("price, note", "price")).toBe(true);
    expect(isChangedCell("price, note", "note (before)")).toBe(true);
    expect(isChangedCell("price, note", "name")).toBe(false);
    expect(isChangedCell(null, "price")).toBe(false);
  });
});
