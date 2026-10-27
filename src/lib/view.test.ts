import { describe, expect, it } from "vitest";
import { describeFilter, filterFamily, isIdentity } from "./view";

describe("view helpers", () => {
  it("knows when a view changes nothing", () => {
    expect(isIdentity({})).toBe(true);
    expect(isIdentity({ filters: [], sort: [], search: "" })).toBe(true);
    expect(isIdentity({ filters: [{ column: "a", op: "isNull" }] })).toBe(false);
    expect(isIdentity({ search: "x" })).toBe(false);
  });

  it("maps column kinds to filter families", () => {
    expect(filterFamily("integer")).toBe("number");
    expect(filterFamily("number")).toBe("number");
    expect(filterFamily("date")).toBe("date");
    expect(filterFamily("timestamp")).toBe("date");
    expect(filterFamily("boolean")).toBe("boolean");
    expect(filterFamily("text")).toBe("text");
    expect(filterFamily("json")).toBe("text");
  });

  it("describes filters for chips", () => {
    const d = describeFilter;
    expect(d({ column: "name", op: "contains", value: "ann" })).toBe('name contains "ann"');
    expect(d({ column: "name", op: "contains", value: "ann", not: true })).toBe(
      'name doesn\'t contain "ann"',
    );
    expect(d({ column: "name", op: "startsWith", value: "A", caseSensitive: true })).toBe(
      'name starts with "A" (match case)',
    );
    expect(d({ column: "name", op: "regex", pattern: "^a" })).toBe("name matches /^a/");
    expect(d({ column: "amount", op: "gt", value: 10 })).toBe("amount > 10");
    expect(d({ column: "amount", op: "equals", value: 3, not: true })).toBe("amount ≠ 3");
    expect(d({ column: "amount", op: "range", min: 1, max: 5 })).toBe("amount between 1 and 5");
    expect(d({ column: "amount", op: "range", min: 1 })).toBe("amount ≥ 1");
    expect(d({ column: "amount", op: "range", max: 5 })).toBe("amount ≤ 5");
    expect(d({ column: "day", op: "lt", value: "2024-01-31" }, "date")).toBe("day < 2024-01-31");
    expect(d({ column: "day", op: "lastDays", days: 1 })).toBe("day in the last 1 day");
    expect(d({ column: "day", op: "lastDays", days: 7 })).toBe("day in the last 7 days");
    expect(d({ column: "city", op: "in", values: ["a", null] })).toBe('city is one of "a", null');
    expect(d({ column: "city", op: "in", values: ["a", "b", "c", "d", "e"] })).toBe(
      'city is one of "a", "b", "c" +2',
    );
    expect(d({ column: "x", op: "isNull" })).toBe("x is null");
    expect(d({ column: "x", op: "empty", not: true })).toBe("x is not empty");
    expect(d({ column: "x", op: "lastDays", days: 3, not: true })).toBe("not x in the last 3 days");
  });
});
