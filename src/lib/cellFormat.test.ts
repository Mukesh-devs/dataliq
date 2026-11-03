import { describe, expect, it } from "vitest";
import { cellFill, describeRule, hasFormat, ruleMatches, type CellRule } from "./cellFormat";
import { defaultLayout, reconcile, setFormat } from "./layout";

const num = { kind: "number" as const };
const int = { kind: "integer" as const };
const text = { kind: "text" as const };
const date = { kind: "date" as const };
const DAY = 86_400_000;
const rule = (op: CellRule["op"], value?: string): CellRule => ({ op, value, color: "red" });

describe("conditional formatting", () => {
  it("compares numbers as numbers", () => {
    expect(ruleMatches(rule("gt", "300"), 301, num)).toBe(true);
    expect(ruleMatches(rule("gt", "300"), 300, num)).toBe(false);
    expect(ruleMatches(rule("gte", "300"), 300n, int)).toBe(true);
    expect(ruleMatches(rule("lt", "9"), 10, num)).toBe(false);
    expect(ruleMatches(rule("eq", "2.50"), 2.5, num)).toBe(true);
    expect(ruleMatches(rule("neq", "2"), 3, num)).toBe(true);
    // NULL never compares.
    expect(ruleMatches(rule("lt", "9"), null, num)).toBe(false);
  });

  it("compares text and dates as text, ignoring case", () => {
    expect(ruleMatches(rule("contains", "FAIL"), "call failed", text)).toBe(true);
    expect(ruleMatches(rule("contains", ""), "anything", text)).toBe(false);
    expect(ruleMatches(rule("eq", "busy"), "Busy", text)).toBe(true);
    expect(ruleMatches(rule("gt", "2024-01-15"), 20 * DAY + Date.UTC(2024, 0, 0), date)).toBe(true);
    expect(ruleMatches(rule("empty"), "", text)).toBe(true);
    expect(ruleMatches(rule("empty"), null, num)).toBe(true);
    expect(ruleMatches(rule("empty"), "x", text)).toBe(false);
  });

  it("fills with the first matching rule, else the scale", () => {
    const format = {
      rules: [rule("gt", "100"), { ...rule("lt", "0"), color: "blue" as const }],
      scale: { min: 0, max: 100, color: "green" as const },
    };
    expect(cellFill(format, 150, num)).toEqual({ color: "red" });
    expect(cellFill(format, -5, num)).toEqual({ color: "blue" });
    expect(cellFill(format, 25, num)).toEqual({ color: "green", strength: 0.25 });
    expect(cellFill(format, null, num)).toBeUndefined();
    // A scale shades numbers only.
    expect(cellFill({ scale: format.scale }, "25", text)).toBeUndefined();
    expect(cellFill(undefined, 1, num)).toBeUndefined();
    // A one-value range is full strength.
    expect(cellFill({ scale: { min: 5, max: 5, color: "red" } }, 5, num)).toEqual({
      color: "red",
      strength: 1,
    });
  });

  it("describes rules and keeps formats with the layout", () => {
    expect(describeRule(rule("gt", "300"))).toBe("greater than 300");
    expect(describeRule(rule("empty"))).toBe("empty");
    let l = setFormat(defaultLayout(["a", "b"]), "a", { rules: [rule("empty")] });
    expect(hasFormat(l.formats?.a)).toBe(true);
    // Columns that go away take their format with them.
    expect(reconcile(l, ["b"]).formats).toEqual({});
    l = setFormat(l, "a", undefined);
    expect(l.formats).toEqual({});
    expect(setFormat(l, "a", { rules: [] }).formats).toEqual({});
  });
});
