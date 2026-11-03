import { describe, expect, it } from "vitest";
import {
  computeStats,
  formatStatNumber,
  normalizeRows,
  rowCount,
  statItems,
  summarize,
  type SelectionStats,
} from "./selectionStats";

const DAY = 86_400_000;

describe("selection statistics in the UI", () => {
  const columns = [
    { name: "amount", kind: "number" as const },
    { name: "minutes", kind: "integer" as const },
    { name: "name", kind: "text" as const },
    { name: "day", kind: "date" as const },
    { name: "ok", kind: "boolean" as const },
  ];
  const values = [
    [1.5, 10n, "b", 3 * DAY, true],
    [null, 20n, "", 1 * DAY, false],
    [2.5, null, "a", null, null],
    [-1, 30n, null, 2 * DAY, true],
  ];

  it("adds up numbers, counts text and finds date and text ranges", () => {
    const s = computeStats(columns, values, true);
    expect(s.rows).toBe(4);
    const [amount, minutes, name, day, ok] = s.columns;
    expect(amount).toMatchObject({ kind: "number", values: 3, sum: 3, avg: 1, min: -1, max: 2.5 });
    expect(minutes).toMatchObject({ values: 3, sum: 60, avg: 20, min: 10, max: 30, distinct: 3 });
    expect(name).toMatchObject({
      kind: "text",
      values: 3,
      empty: 1,
      sum: null,
      minText: "",
      maxText: "b",
      distinct: 3,
    });
    expect(day).toMatchObject({
      kind: "temporal",
      values: 3,
      minText: "1970-01-02",
      maxText: "1970-01-04",
    });
    expect(ok).toMatchObject({ kind: "boolean", values: 3, minText: null, distinct: 2 });
  });

  it("counts distinct values only when asked", () => {
    expect(computeStats(columns, values, false).columns[0]!.distinct).toBeNull();
  });

  it("reads decimals through their scale", () => {
    // Arrow decimals: an object whose String() is the unscaled integer.
    const dec = { toString: () => "12345" };
    const s = computeStats([{ name: "d", kind: "number", scale: 2 }], [[dec], [dec]], false);
    expect(s.columns[0]!.sum).toBeCloseTo(246.9);
  });
});

describe("summarizing a selection", () => {
  const stats: SelectionStats = {
    rows: 4,
    distinctApprox: false,
    columns: [
      {
        column: "a",
        kind: "number",
        values: 3,
        empty: 0,
        sum: 6,
        avg: 2,
        min: 1,
        max: 3,
        minText: null,
        maxText: null,
        distinct: null,
      },
      {
        column: "b",
        kind: "number",
        values: 2,
        empty: 0,
        sum: 14,
        avg: 7,
        min: -2,
        max: 16,
        minText: null,
        maxText: null,
        distinct: null,
      },
      {
        column: "t",
        kind: "text",
        values: 4,
        empty: 1,
        sum: null,
        avg: null,
        min: null,
        max: null,
        minText: "x",
        maxText: "y",
        distinct: null,
      },
    ],
  };

  it("combines columns like a spreadsheet", () => {
    const s = summarize(stats);
    expect(s).toMatchObject({
      rows: 4,
      columns: 3,
      cells: 12,
      count: 8,
      blank: 4,
      numbers: 5,
      sum: 20,
      avg: 4,
      min: -2,
      max: 16,
      // Several columns: no text range and no distinct count.
      minText: null,
      distinct: null,
    });
  });

  it("gives the range and distinct values of one date or text column", () => {
    const s = summarize({ ...stats, columns: [{ ...stats.columns[2]!, distinct: 3 }] });
    expect(s).toMatchObject({ sum: null, avg: null, minText: "x", maxText: "y", distinct: 3 });
    const items = statItems(s, ["count", "sum", "avg", "min", "max", "distinct"]);
    expect(items.map((i) => `${i.label} ${i.text}`)).toEqual([
      "Count 3",
      "Min x",
      "Max y",
      "Distinct 3",
    ]);
  });

  it("shows the chosen statistics that apply, copying plain values", () => {
    const items = statItems(summarize(stats), [
      "count",
      "numbers",
      "sum",
      "avg",
      "min",
      "max",
      "blank",
    ]);
    expect(items.map((i) => [i.label, i.text, i.copy])).toEqual([
      ["Count", "8", "8"],
      ["Numerical count", "5", "5"],
      ["Sum", "20", "20"],
      ["Average", "4", "4"],
      ["Min", "-2", "-2"],
      ["Max", "16", "16"],
      ["Blank", "4", "4"],
    ]);
  });

  it("marks an estimated distinct count", () => {
    const s = summarize({
      ...stats,
      distinctApprox: true,
      columns: [{ ...stats.columns[0]!, distinct: 1_200_000 }],
    });
    expect(statItems(s, ["distinct"])[0]!.text).toBe("≈1,200,000");
  });
});

describe("selection rows", () => {
  it("treats a range over every row as the whole view", () => {
    expect(normalizeRows([[0, 50]], 50)).toBe("all");
    expect(normalizeRows([[0, 49]], 50)).toEqual([[0, 49]]);
    expect(
      normalizeRows(
        [
          [0, 2],
          [5, 9],
        ],
        9,
      ),
    ).toEqual([
      [0, 2],
      [5, 9],
    ]);
  });

  it("counts rows", () => {
    expect(rowCount("all", 1234)).toBe(1234);
    expect(
      rowCount(
        [
          [0, 2],
          [5, 9],
        ],
        100,
      ),
    ).toBe(6);
  });

  it("formats numbers with separators and a few decimals", () => {
    expect(formatStatNumber(1234567)).toBe("1,234,567");
    expect(formatStatNumber(0.123456)).toBe("0.1235");
    expect(formatStatNumber(12345.6789)).toBe("12,345.68");
  });
});
