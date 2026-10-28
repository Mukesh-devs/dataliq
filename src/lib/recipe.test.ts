import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import {
  appliedSteps,
  columnGaps,
  describeGaps,
  describeStep,
  fitView,
  hasEffect,
  readableScript,
  recipeFileName,
  type StepOutcome,
} from "./recipe";

const ok: StepOutcome = { error: null, failed: null, skipped: false };

describe("recipes", () => {
  it("describes each step in a line", () => {
    expect(describeStep({ op: "rename", column: "nm", to: "name" })).toBe("Rename “nm” to “name”");
    expect(describeStep({ op: "changeType", column: "d", to: "date", format: "%d/%m/%Y" })).toBe(
      "Change “d” to date (%d/%m/%Y)",
    );
    expect(describeStep({ op: "changeCase", column: "n", case: "title" })).toBe(
      "“n” in Title Case",
    );
    expect(
      describeStep({ op: "split", column: "n", delimiter: " ", into: ["first", "last"] }),
    ).toBe("Split “n” at “ ” into “first”, “last”");
    expect(describeStep({ op: "removeDuplicates" })).toBe("Remove duplicate rows");
    expect(describeStep({ op: "removeDuplicates", columns: ["email"] })).toBe(
      "Remove duplicates by “email”",
    );
    expect(
      describeStep({ op: "removeRows", filter: { column: "amount", op: "lt", value: 0 } }),
    ).toBe("Remove rows where amount < 0");
    expect(describeStep({ op: "calculate", name: "total", expression: "a * b" })).toBe(
      "New column “total” = a * b",
    );
  });

  it("an empty or all-off recipe leaves the file as it is", () => {
    expect(hasEffect(undefined)).toBe(false);
    expect(hasEffect([{ op: "trim", column: "a", enabled: false }])).toBe(false);
    expect(hasEffect([{ op: "trim", column: "a" }])).toBe(true);
  });

  it("drops filters, sort keys and columns the recipe removed", () => {
    const view = {
      filters: [
        { column: "a", op: "isNull" as const },
        { column: "gone", op: "isNull" as const },
      ],
      sort: [{ column: "gone" }],
      search: "x",
    };
    expect(fitView(view, ["a", "b"])).toEqual({
      filters: [{ column: "a", op: "isNull" }],
      sort: [],
      search: "x",
      columns: undefined,
    });
    // Unchanged views keep their identity (no re-run).
    const kept = { filters: [{ column: "a", op: "isNull" as const }] };
    expect(fitView(kept, ["a"])).toBe(kept);
    expect(fitView(undefined, ["a"])).toBeUndefined();
  });

  it("a script covers the steps before the first that fails", () => {
    const steps = [
      { op: "trim" as const, column: "a" },
      { op: "calculate" as const, name: "x", expression: "nope" },
      { op: "trim" as const, column: "b" },
    ];
    expect(appliedSteps(steps, [ok, ok, ok])).toBe(steps);
    expect(appliedSteps(steps, [ok, { ...ok, error: "no" }, { ...ok, skipped: true }])).toEqual([
      steps[0],
    ]);
  });
});

describe("recipe files", () => {
  afterEach(() => clearMocks());

  it("tells what another file lacks", () => {
    const wanted = [
      { name: "id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "city", type: "VARCHAR" },
      { name: "amount", type: "DOUBLE" },
    ];
    const have = [
      { name: "id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "amount", type: "VARCHAR" },
      { name: "extra", type: "DATE" },
    ];
    const gaps = columnGaps(wanted, have);
    expect(gaps).toEqual({
      missing: ["city"],
      retyped: [{ name: "amount", wanted: "DOUBLE", have: "VARCHAR" }],
    });
    expect(describeGaps(gaps)).toBe(
      "This file has no column “city”; “amount” is VARCHAR, not DOUBLE: steps using them may fail.",
    );
    expect(describeGaps(columnGaps(wanted, wanted))).toBeNull();
  });

  it("names files after the data", () => {
    expect(recipeFileName("people.csv.gz", "json")).toBe("people-recipe.json");
    expect(recipeFileName("Result 1", "sql")).toBe("Result 1-recipe.sql");
  });

  it("a script says what it is and labels every step", async () => {
    let args: Record<string, unknown> = {};
    mockIPC((cmd, a) => {
      args = a as Record<string, unknown>;
      return cmd === "recipe_script" ? "WITH base AS (…)\nSELECT * FROM step_1;" : null;
    });
    const steps = [
      { op: "trim" as const, column: "name" },
      { op: "trim" as const, column: "city", enabled: false },
    ];
    const sql = await readableScript("ds1", steps, "read_csv('p.csv')", "people.csv");
    expect(sql).toBe(
      "-- DataLiq recipe for people.csv: 1 step.\n" +
        "-- Runs as-is in DuckDB: it reads the file and gives the cleaned rows.\n" +
        "WITH base AS (…)\nSELECT * FROM step_1;",
    );
    expect(args).toMatchObject({
      datasetId: "ds1",
      reader: "read_csv('p.csv')",
      labels: ["Trim spaces in “name”", "Trim spaces in “city”"],
    });
  });
});
