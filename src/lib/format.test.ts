import { describe, expect, it } from "vitest";
import { formatBytes, formatCount, formatDuration, formatValue, toJsonText } from "./format";

describe("formatValue", () => {
  it("keeps NULL distinct from empty text", () => {
    expect(formatValue(null, "text")).toBeNull();
    expect(formatValue("", "text")).toBe("");
  });

  it("formats dates and timestamps in UTC", () => {
    expect(formatValue(Date.UTC(2024, 0, 31), "date")).toBe("2024-01-31");
    expect(formatValue(Date.UTC(2024, 0, 31, 12, 34, 56, 789), "timestamp")).toBe(
      "2024-01-31 12:34:56.789",
    );
    expect(formatValue(Date.UTC(1999, 11, 31, 23, 59, 59), "timestamp")).toBe(
      "1999-12-31 23:59:59",
    );
  });

  it("formats big integers, booleans and binary", () => {
    expect(formatValue(9007199254740993n, "integer")).toBe("9007199254740993");
    expect(formatValue(false, "boolean")).toBe("false");
    expect(formatValue(new Uint8Array([0xaa, 0xbb]), "binary")).toBe("\\xaabb");
  });

  it("renders nested values as JSON", () => {
    expect(toJsonText({ a: 1n, b: [1, 2], c: new Int32Array([3]) })).toBe(
      '{"a":"1","b":[1,2],"c":[3]}',
    );
  });
});

describe("number helpers", () => {
  it("formats counts, bytes and durations", () => {
    expect(formatCount(48210331)).toBe("48,210,331");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatDuration(210)).toBe("210 ms");
    expect(formatDuration(1400)).toBe("1.40 s");
  });
});
