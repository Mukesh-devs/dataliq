import { describe, expect, it } from "vitest";
import { formatRows, sqlLiteral, tableName, type CopyColumn } from "./copyAs";

const DAY = 86_400_000;
const columns: CopyColumn[] = [
  { name: "id", label: "id", format: { kind: "integer" } },
  { name: "name", label: "Full name", format: { kind: "text" } },
  { name: "amount", label: "amount", format: { kind: "number" } },
  { name: "joined", label: "joined", format: { kind: "date" } },
  { name: "active", label: "active", format: { kind: "boolean" } },
];
const rows: unknown[][] = [
  [1n, 'Ann, "the" first', 9.5, 19_737 * DAY, true],
  [2n, null, null, null, false],
  [3n, "O'Neil | tab\there\nnext", -0.25, 0, null],
];

describe("formatRows", () => {
  it("CSV quotes fields with commas, quotes and line breaks; NULL is empty", () => {
    expect(formatRows("csv", columns, rows)).toBe(
      [
        "id,Full name,amount,joined,active",
        '1,"Ann, ""the"" first",9.5,2024-01-15,true',
        "2,,,,false",
        '3,"O\'Neil | tab\there\nnext",-0.25,1970-01-01,',
      ].join("\n"),
    );
  });

  it("TSV quotes fields with tabs, quotes or line breaks (not commas)", () => {
    const out = formatRows("tsv", columns, rows).split("\n");
    expect(out[0]).toBe("id\tFull name\tamount\tjoined\tactive");
    expect(out[1]).toBe('1\t"Ann, ""the"" first"\t9.5\t2024-01-15\ttrue');
    expect(formatRows("tsv", columns.slice(0, 1), [[1n]])).toBe("id\n1");
    expect(formatRows("tsv", columns.slice(0, 2), [[1n, "a"]], { headers: false })).toBe("1\ta");
    // Quoted because of the tab and the line break inside it.
    expect(out[3]).toBe("3\t\"O'Neil | tab\there");
  });

  it("Markdown escapes pipes, keeps line breaks as <br> and right-aligns numbers", () => {
    expect(formatRows("markdown", columns, rows)).toBe(
      [
        "| id | Full name | amount | joined | active |",
        "| ---: | --- | ---: | --- | --- |",
        '| 1 | Ann, "the" first | 9.5 | 2024-01-15 | true |',
        "| 2 |  |  |  | false |",
        "| 3 | O'Neil \\| tab\there<br>next | -0.25 | 1970-01-01 |  |",
      ].join("\n"),
    );
  });

  it("JSON keeps numbers, booleans and nulls typed, keyed by display name", () => {
    const parsed = JSON.parse(formatRows("json", columns, rows)) as unknown[];
    expect(parsed[0]).toEqual({
      id: 1,
      "Full name": 'Ann, "the" first',
      amount: 9.5,
      joined: "2024-01-15",
      active: true,
    });
    expect(parsed[1]).toEqual({
      id: 2,
      "Full name": null,
      amount: null,
      joined: null,
      active: false,
    });
  });

  it("JSON keeps big integers exact as strings, short decimals as numbers", () => {
    const cols: CopyColumn[] = [
      { name: "big", label: "big", format: { kind: "integer" } },
      { name: "price", label: "price", format: { kind: "number", scale: 2 } },
      { name: "doc", label: "doc", format: { kind: "json" } },
    ];
    const decimal = { toString: () => "1250" }; // Arrow decimal: unscaled digits
    const out = JSON.parse(
      formatRows("json", cols, [[9_007_199_254_740_993n, decimal, '{"a":[1,2]}']]),
    ) as Record<string, unknown>[];
    expect(out[0]).toEqual({ big: "9007199254740993", price: 12.5, doc: '{"a":[1,2]}' });
  });

  it("SQL INSERT uses real column names and typed literals", () => {
    expect(formatRows("sql", columns, rows, { table: 'my "table"' })).toBe(
      [
        'INSERT INTO "my ""table""" ("id", "name", "amount", "joined", "active") VALUES',
        "  (1, 'Ann, \"the\" first', 9.5, DATE '2024-01-15', true),",
        "  (2, NULL, NULL, NULL, false),",
        "  (3, 'O''Neil | tab\there\nnext', -0.25, DATE '1970-01-01', NULL);",
      ].join("\n"),
    );
  });
});

describe("sqlLiteral", () => {
  it("writes special numbers, timestamps, times and bytes", () => {
    const col = (kind: CopyColumn["format"]["kind"]): CopyColumn => ({
      name: "c",
      label: "c",
      format: { kind },
    });
    expect(sqlLiteral(Number.NaN, col("number"))).toBe("'NaN'::DOUBLE");
    expect(sqlLiteral(1e21, col("number"))).toBe("1e+21");
    expect(sqlLiteral(Date.UTC(2024, 0, 2, 3, 4, 5), col("timestamp"))).toBe(
      "TIMESTAMP '2024-01-02 03:04:05'",
    );
    expect(sqlLiteral(3_600_000_000n, col("time"))).toBe("TIME '01:00:00'");
    expect(sqlLiteral(new Uint8Array([0, 255, 16]), col("binary"))).toBe("from_hex('00ff10')");
  });
});

describe("tableName", () => {
  it("drops the extension and compression suffix", () => {
    expect(tableName("sales 2024.csv.gz")).toBe("sales 2024");
    expect(tableName("events.ndjson.zst")).toBe("events");
    expect(tableName("data.parquet")).toBe("data");
    expect(tableName(".csv")).toBe("data");
  });
});
