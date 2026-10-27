import { describe, expect, it } from "vitest";
import { NOT_LOADED, type RowSource } from "./rowSource";
import { readRows, runs } from "./readRows";

/** A source that only has the rows it was last asked to load. */
function fake(rowCount: number): RowSource & { loads: [number, number][] } {
  let loaded: [number, number] = [0, 0];
  const loads: [number, number][] = [];
  return {
    rowCount,
    columns: [],
    loads,
    getValue: (row, col) => (row >= loaded[0] && row < loaded[1] ? `${row}:${col}` : NOT_LOADED),
    ensure: () => {},
    load: (start, end) => {
      loads.push([start, end]);
      loaded = [start, end];
      return Promise.resolve();
    },
    subscribe: () => () => {},
    dispose: () => {},
  };
}

describe("runs", () => {
  it("groups consecutive rows", () => {
    expect(runs([0, 1, 2, 5, 7, 8])).toEqual([
      [0, 3],
      [5, 6],
      [7, 9],
    ]);
    expect(runs([])).toEqual([]);
  });
});

describe("readRows", () => {
  it("loads each run in chunks and reads the requested columns", async () => {
    const source = fake(50_000_000);
    const rows = [...Array.from({ length: 12_000 }, (_, i) => i), 49_999_999];
    const out = await readRows(source, rows, [2, 0]);
    expect(out).toHaveLength(12_001);
    expect(out[0]).toEqual(["0:2", "0:0"]);
    expect(out.at(-1)).toEqual(["49999999:2", "49999999:0"]);
    // Never one huge load spanning the gap.
    expect(source.loads).toEqual([
      [0, 5000],
      [5000, 10_000],
      [10_000, 12_000],
      [49_999_999, 50_000_000],
    ]);
  });

  it("fails when a row can't be loaded", async () => {
    const source = { ...fake(10), load: () => Promise.resolve() };
    await expect(readRows(source, [3], [0])).rejects.toThrow("Row 4 could not be loaded.");
  });
});
