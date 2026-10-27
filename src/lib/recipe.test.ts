import { describe, expect, it } from "vitest";
import { appliedSteps, describeStep, fitView, hasEffect, type StepOutcome } from "./recipe";

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
