import { describe, expect, it } from "vitest";
import { chartsFor, FIRST_CHARTS, windowRange } from "./virtual";

describe("windowRange", () => {
  it("covers the rows in view plus the overscan, clamped to the list", () => {
    expect(windowRange(0, 240, 24, 5000, 8)).toEqual({ first: 0, last: 18 });
    expect(windowRange(2400, 240, 24, 5000, 8)).toEqual({ first: 92, last: 118 });
    expect(windowRange(1e9, 240, 24, 50, 8)).toEqual({ first: 50, last: 50 });
  });
});

describe("chartsFor", () => {
  const cols = Array.from({ length: 100 }, (_, i) => `c${i}`);
  it("takes the first ones until the grid says what it shows", () => {
    expect(chartsFor(cols, null)).toHaveLength(FIRST_CHARTS);
  });
  it("then only the ones in view, in file order", () => {
    expect(chartsFor(cols, new Set(["c50", "c3", "text column"]))).toEqual(["c3", "c50"]);
  });
});
