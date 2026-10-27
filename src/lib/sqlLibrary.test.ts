import { describe, expect, it } from "vitest";
import { firstLine, formatAgo } from "./sqlLibrary";

describe("formatAgo", () => {
  const now = new Date(2026, 9, 27, 12, 0, 0).getTime();
  it("says how long ago in words", () => {
    expect(formatAgo(now - 10_000, now)).toBe("just now");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatAgo(new Date(2026, 9, 26, 9, 0).getTime(), now)).toBe("yesterday");
    expect(formatAgo(new Date(2026, 8, 1, 9, 0).getTime(), now)).toBe("2026-09-01");
    expect(formatAgo(now + 5000, now)).toBe("just now");
  });
});

describe("firstLine", () => {
  it("skips blank lines and comments", () => {
    expect(firstLine("\n-- top cities\n  SELECT city\nFROM people")).toBe("SELECT city");
    expect(firstLine("-- only a comment")).toBe("-- only a comment");
  });
});
