import { describe, expect, it } from "vitest";
import type { Filter } from "../../lib/view";
import { emptyDraft, fromFilter, OPS, toFilter, type Draft } from "./draft";

const draft = (changes: Partial<Draft>, family: Parameters<typeof emptyDraft>[0] = "text") => ({
  ...emptyDraft(family),
  ...changes,
});

describe("filter drafts", () => {
  it("offers conditions that fit each type", () => {
    expect(OPS.text[0]).toBe("contains");
    expect(OPS.number).toContain("range");
    expect(OPS.date).toContain("lastDays");
    expect(OPS.boolean).toEqual(["isTrue", "isFalse", "isNull", "notNull"]);
    expect(emptyDraft("number").op).toBe("equals");
  });

  it("turns text drafts into filters", () => {
    expect(toFilter("name", "text", draft({ op: "contains", value: "ann" }))).toEqual({
      filter: { column: "name", op: "contains", value: "ann" },
    });
    expect(
      toFilter(
        "name",
        "text",
        draft({ op: "endsWith", value: "Z", caseSensitive: true, not: true }),
      ),
    ).toEqual({
      filter: { column: "name", op: "endsWith", value: "Z", caseSensitive: true, not: true },
    });
    expect(toFilter("name", "text", draft({ op: "regex", value: "^a" }))).toEqual({
      filter: { column: "name", op: "regex", pattern: "^a" },
    });
    // Spaces matter in text.
    expect(toFilter("name", "text", draft({ op: "equals", value: " a " }))).toEqual({
      filter: { column: "name", op: "equals", value: " a " },
    });
    expect(toFilter("name", "text", draft({ op: "contains", value: "" }))).toEqual({
      error: "Enter some text.",
    });
  });

  it("parses and checks numbers", () => {
    expect(toFilter("n", "number", draft({ op: "gt", value: " 2.5 " }, "number"))).toEqual({
      filter: { column: "n", op: "gt", value: 2.5 },
    });
    expect(toFilter("n", "number", draft({ op: "gt", value: "abc" }, "number"))).toEqual({
      error: '"abc" is not a number.',
    });
    // Integers beyond 2^53 stay exact as text.
    expect(
      toFilter("n", "number", draft({ op: "equals", value: "9007199254740993" }, "number")),
    ).toEqual({ filter: { column: "n", op: "equals", value: "9007199254740993" } });
    expect(toFilter("n", "number", draft({ op: "range", value: "1" }, "number"))).toEqual({
      filter: { column: "n", op: "range", min: 1 },
    });
    expect(
      toFilter("n", "number", draft({ op: "range", value: "", value2: "9" }, "number")),
    ).toEqual({ filter: { column: "n", op: "range", max: 9 } });
    expect(toFilter("n", "number", draft({ op: "range" }, "number"))).toHaveProperty("error");
  });

  it("handles dates, booleans, null tests and value lists", () => {
    expect(toFilter("d", "date", draft({ op: "lt", value: "2024-01-31" }, "date"))).toEqual({
      filter: { column: "d", op: "lt", value: "2024-01-31" },
    });
    expect(toFilter("d", "date", draft({ op: "lastDays", days: "7" }, "date"))).toEqual({
      filter: { column: "d", op: "lastDays", days: 7 },
    });
    expect(toFilter("d", "date", draft({ op: "lastDays", days: "-1" }, "date"))).toHaveProperty(
      "error",
    );
    expect(toFilter("b", "boolean", draft({ op: "isFalse" }, "boolean"))).toEqual({
      filter: { column: "b", op: "equals", value: false },
    });
    // Null tests are not negated (they are each other's opposite).
    expect(toFilter("x", "text", draft({ op: "isNull", not: true }))).toEqual({
      filter: { column: "x", op: "isNull" },
    });
    expect(toFilter("x", "text", draft({ op: "in", selected: ["a", null] }))).toEqual({
      filter: { column: "x", op: "in", values: ["a", null] },
    });
    expect(toFilter("x", "text", draft({ op: "in" }))).toEqual({
      error: "Pick at least one value.",
    });
  });

  it("round-trips filters through the editor state", () => {
    const cases: [Filter, Parameters<typeof emptyDraft>[0]][] = [
      [{ column: "c", op: "contains", value: "x", caseSensitive: true, not: true }, "text"],
      [{ column: "c", op: "regex", pattern: "a+" }, "text"],
      [{ column: "c", op: "range", min: 1, max: 2 }, "number"],
      [{ column: "c", op: "lte", value: 7 }, "number"],
      [{ column: "c", op: "range", min: "2024-01-01" }, "date"],
      [{ column: "c", op: "lastDays", days: 30 }, "date"],
      [{ column: "c", op: "equals", value: true }, "boolean"],
      [{ column: "c", op: "in", values: ["a", null] }, "text"],
      [{ column: "c", op: "empty", not: true }, "text"],
      [{ column: "c", op: "notNull" }, "number"],
    ];
    for (const [f, family] of cases) {
      expect(toFilter("c", family, fromFilter(f, family))).toEqual({ filter: f });
    }
  });
});
