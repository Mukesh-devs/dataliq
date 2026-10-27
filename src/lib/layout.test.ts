import { describe, expect, it } from "vitest";
import {
  defaultLayout,
  fitWidth,
  label,
  move,
  pinnedCount,
  reconcile,
  rename,
  setHidden,
  setPinned,
  setWidth,
  showAll,
  visible,
} from "./layout";

const base = () => defaultLayout(["a", "b", "c", "d", "e"]);

describe("column layout", () => {
  it("hides and shows columns in place", () => {
    let l = setHidden(base(), "b", true);
    l = setHidden(l, "d", true);
    expect(visible(l)).toEqual(["a", "c", "e"]);
    l = setHidden(l, "b", false);
    expect(visible(l)).toEqual(["a", "b", "c", "e"]);
    expect(visible(showAll(l))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("never hides the last shown column", () => {
    let l = defaultLayout(["a", "b"]);
    l = setHidden(l, "a", true);
    expect(setHidden(l, "b", true)).toBe(l);
    expect(visible(l)).toEqual(["b"]);
  });

  it("pins columns to the left in pin order", () => {
    let l = setPinned(base(), "c", true);
    l = setPinned(l, "e", true);
    expect(visible(l)).toEqual(["c", "e", "a", "b", "d"]);
    expect(pinnedCount(l)).toBe(2);
    l = setPinned(l, "c", false);
    expect(visible(l)).toEqual(["e", "c", "a", "b", "d"]);
    expect(pinnedCount(l)).toBe(1);
    // Hidden pinned columns don't count as frozen.
    expect(pinnedCount(setHidden(l, "e", true))).toBe(0);
  });

  it("moves shown columns, keeping hidden ones next to their neighbour", () => {
    let l = setHidden(base(), "c", true); // shown: a b d e
    l = move(l, 0, 2); // a after d
    expect(visible(l)).toEqual(["b", "d", "a", "e"]);
    // c stays after b, where it was.
    expect(l.order).toEqual(["b", "c", "d", "a", "e"]);
    expect(move(l, 1, 1)).toBe(l);
  });

  it("dropping into or out of the pinned block pins or unpins", () => {
    let l = setPinned(base(), "a", true); // a | b c d e
    l = move(l, 3, 0); // d before a: pinned
    expect(visible(l)).toEqual(["d", "a", "b", "c", "e"]);
    expect(l.pinned).toEqual(["d", "a"]);
    l = move(l, 0, 1); // d after a: still in the pinned block
    expect(l.pinned).toEqual(["a", "d"]);
    l = move(l, 1, 3); // d out of the block
    expect(visible(l)).toEqual(["a", "b", "c", "d", "e"]);
    expect(l.pinned).toEqual(["a"]);
    l = move(l, 2, 1); // c right after the pinned block: not pinned
    expect(l.pinned).toEqual(["a"]);
    expect(visible(l)).toEqual(["a", "c", "b", "d", "e"]);
  });

  it("renames for display only", () => {
    let l = rename(base(), "a", "  Order id ");
    expect(label(l, "a")).toBe("Order id");
    expect(label(l, "b")).toBe("b");
    l = rename(l, "a", "a");
    expect(l.labels).toEqual({});
    expect(rename(l, "a", "   ").labels).toEqual({});
  });

  it("keeps widths within limits", () => {
    expect(setWidth(base(), "a", 10).widths.a).toBe(50);
    expect(setWidth(base(), "a", 900).widths.a).toBe(500);
    expect(setWidth(base(), "a", 123.4).widths.a).toBe(123);
  });

  it("reconciles with a new set of columns", () => {
    let l = setPinned(setHidden(rename(base(), "b", "B"), "c", true), "e", true);
    l = setWidth(l, "d", 200);
    const r = reconcile(l, ["a", "b", "d", "e", "f"]);
    expect(r.order).toEqual(["e", "a", "b", "d", "f"]);
    expect(r.hidden).toEqual([]);
    expect(r.pinned).toEqual(["e"]);
    expect(r.labels).toEqual({ b: "B" });
    expect(r.widths).toEqual({ d: 200 });
    expect(reconcile(undefined, ["x"])).toEqual(defaultLayout(["x"]));
  });

  it("fits the widest of header and values", () => {
    const measure = { header: (s: string) => s.length * 7, cell: (s: string) => s.length * 8 };
    const opts = { padding: 8, headerExtra: 40 };
    expect(fitWidth("amount", ["1", "22"], measure, opts)).toBe(6 * 7 + 40 + 16);
    expect(fitWidth("id", ["a long value here"], measure, opts)).toBe(17 * 8 + 16);
    expect(fitWidth("x", [], measure, { padding: 0, headerExtra: 0 })).toBe(50);
    expect(fitWidth("x", ["y".repeat(200)], measure, opts)).toBe(500);
  });
});
