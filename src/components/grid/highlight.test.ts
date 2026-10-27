import { describe, expect, it, vi } from "vitest";
import { findMatches, paintMatches } from "./highlight";

describe("search highlights", () => {
  it("finds every case-insensitive match", () => {
    expect(findMatches("Anna Ann ANN", "ann")).toEqual([
      [0, 3],
      [5, 8],
      [9, 12],
    ]);
    expect(findMatches("Zoë Müller", "MÜ")).toEqual([[4, 6]]);
    expect(findMatches("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(findMatches("abc", "x")).toEqual([]);
    expect(findMatches("abc", "")).toEqual([]);
    expect(findMatches("", "a")).toEqual([]);
    // Characters whose lower case is longer: no offsets to map, no highlight.
    expect(findMatches("İstanbul", "stan")).toEqual([]);
  });

  it("paints behind each match, measured from the cell's padding", () => {
    const fillRect = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fillRect,
      // 10 px per character.
      measureText: (s: string) => ({ width: s.length * 10 }),
      font: "",
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
    const n = paintMatches(
      ctx,
      "a smith smith",
      "SMITH",
      { x: 100, y: 0, width: 300, height: 34 },
      { font: "13px Inter", padding: 8, color: "yellow" },
    );
    expect(n).toBe(2);
    expect(fillRect).toHaveBeenNthCalledWith(1, 128, 4, 50, 26);
    expect(fillRect).toHaveBeenNthCalledWith(2, 188, 4, 50, 26);
    // Nothing to paint: the canvas is left alone.
    expect(
      paintMatches(
        ctx,
        "abc",
        "zz",
        { x: 0, y: 0, width: 9, height: 9 },
        {
          font: "",
          padding: 0,
          color: "",
        },
      ),
    ).toBe(0);
    expect(fillRect).toHaveBeenCalledTimes(2);
  });
});
