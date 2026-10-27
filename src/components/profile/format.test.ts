import { describe, expect, it } from "vitest";
import { formatEdge, formatPercent, formatStat } from "./format";

describe("profile formatting", () => {
  it("formats statistics", () => {
    expect(formatStat(1234567)).toBe("1,234,567");
    expect(formatStat(500.5)).toBe("500.5");
    expect(formatStat(1 / 3)).toBe("0.3333");
    expect(formatStat(-25.74)).toBe("-25.74");
  });

  it("formats percentages", () => {
    expect(formatPercent(0, 0)).toBe("0%");
    expect(formatPercent(20, 1000)).toBe("2.0%");
    expect(formatPercent(1, 100_000)).toBe("<0.1%");
    expect(formatPercent(500, 1000)).toBe("50%");
    expect(formatPercent(0, 10)).toBe("0.0%");
  });

  it("formats histogram edges", () => {
    expect(formatEdge(10.5, "number")).toBe("10.5");
    expect(formatEdge(1704067200, "temporal")).toBe("2024-01-01");
    expect(formatEdge(1704067200 + 3600, "temporal", 86400)).toBe("2024-01-01 01:00:00");
  });
});
