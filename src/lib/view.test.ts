import { describe, expect, it } from "vitest";
import { describeFilter, filterFamily, isIdentity, sortMark, toggleSort } from "./view";

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

describe("sorting from the header", () => {
  it("a click cycles ascending, descending, unsorted", () => {
    let s = toggleSort([], "a", false);
    expect(s).toEqual([{ column: "a" }]);
    s = toggleSort(s, "a", false);
    expect(s).toEqual([{ column: "a", descending: true }]);
    expect(toggleSort(s, "a", false)).toEqual([]);
    // Another column replaces the sort.
    expect(toggleSort(s, "b", false)).toEqual([{ column: "b" }]);
  });

  it("Shift adds keys and cycles them in place", () => {
    let s = toggleSort([{ column: "a" }], "b", true);
    expect(s).toEqual([{ column: "a" }, { column: "b" }]);
    s = toggleSort(s, "a", true);
    expect(s).toEqual([{ column: "a", descending: true }, { column: "b" }]);
    s = toggleSort(s, "a", true);
    expect(s).toEqual([{ column: "b" }]);
    // A plain click on a multi-key sort starts over with that column.
    expect(toggleSort([{ column: "a" }, { column: "b" }], "b", false)).toEqual([{ column: "b" }]);
  });

  it("marks sorted headers", () => {
    expect(sortMark([], "a")).toBe("");
    expect(sortMark([{ column: "a", descending: true }], "a")).toBe("↓");
    const two = [{ column: "a" }, { column: "b", descending: true }];
    expect(sortMark(two, "a")).toBe("↑1");
    expect(sortMark(two, "b")).toBe("↓2");
    expect(sortMark(two, "c")).toBe("");
  });
});
