import { describe, expect, it } from "vitest";
import { histogramBars, paintHistogram } from "./headerChart";

const rect = { x: 10, y: 20, width: 40, height: 10 };
const bins = (...counts: number[]) => counts.map((count, i) => ({ lo: i, hi: i + 1, count }));

describe("histogramBars", () => {
  it("scales bars to the tallest bin and bottom-aligns them", () => {
    const bars = histogramBars(bins(5, 10, 0, 1), rect);
    expect(bars).toHaveLength(3); // the empty bin draws nothing
    expect(bars[0]).toEqual({ x: 10, y: 25, width: 9, height: 5 });
    expect(bars[1]).toEqual({ x: 20, y: 20, width: 9, height: 10 });
    // 1 of 10 is 1 px tall, at the fourth slot.
    expect(bars[2]).toEqual({ x: 40, y: 29, width: 9, height: 1 });
  });

  it("keeps rare values visible", () => {
    const [, rare] = histogramBars(bins(1_000_000, 1), rect);
    expect(rare!.height).toBe(1);
  });

  it("draws nothing without counts or room", () => {
    expect(histogramBars([], rect)).toEqual([]);
    expect(histogramBars(bins(0, 0), rect)).toEqual([]);
    expect(histogramBars(bins(1), { ...rect, width: 0 })).toEqual([]);
  });

  it("drops the gap when bars are narrow", () => {
    const bars = histogramBars(bins(...Array<number>(40).fill(1)), rect);
    expect(bars[0]!.width).toBe(1);
  });
});

describe("paintHistogram", () => {
  it("fills one rectangle per bar in the given colour", () => {
    const calls: number[][] = [];
    const styles: string[] = [];
    const ctx = {
      save() {},
      restore() {},
      set fillStyle(v: string) {
        styles.push(v);
      },
      fillRect: (...a: number[]) => calls.push(a),
    } as unknown as CanvasRenderingContext2D;
    paintHistogram(ctx, bins(1, 2), rect, "red");
    expect(calls).toHaveLength(2);
    expect(styles).toEqual(["red"]);
  });
});
