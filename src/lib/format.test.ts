import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatTime,
  formatValue,
  formatWhen,
  scaleDecimal,
  toJsonText,
} from "./format";

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
      '{"a":1,"b":[1,2],"c":[3]}',
    );
    // Too big for a JS number: kept exact as a string.
    expect(toJsonText([9007199254740993n])).toBe('["9007199254740993"]');
  });
});

describe("decimals and times", () => {
  it("places the decimal point by scale", () => {
    expect(scaleDecimal("1234", 2)).toBe("12.34");
    expect(scaleDecimal("-1", 2)).toBe("-0.01");
    expect(scaleDecimal("5", 0)).toBe("5");
    expect(formatValue({ toString: () => "-1234" }, { kind: "number", scale: 2 })).toBe("-12.34");
  });

  it("formats times of day from ticks", () => {
    expect(formatTime(45_296_000_000n, 1e6)).toBe("12:34:56");
    expect(formatTime(45_296_789_000n, 1e6)).toBe("12:34:56.789");
    expect(formatTime(0, 1)).toBe("00:00:00");
    expect(formatValue(45_296_000_000n, { kind: "time", timeTicksPerSecond: 1e6 })).toBe(
      "12:34:56",
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

describe("formatWhen", () => {
  // Local times: the function works in the user's time zone.
  const now = new Date(2026, 10, 16, 18, 30).getTime(); // Mon 16 Nov 2026
  const at = (d: number, h = 9, m = 15, month = 10, y = 2026) =>
    new Date(y, month, d, h, m).getTime();

  it("says today with the time, then yesterday", () => {
    expect(formatWhen(at(16, 10, 42), now, "en-GB")).toBe("Today, 10:42");
    expect(formatWhen(at(16, 0, 1), now, "en-GB")).toBe("Today, 00:01");
    expect(formatWhen(at(15, 23, 59), now, "en-GB")).toBe("Yesterday");
  });

  it("names the weekday this week, the date before, and the year when it differs", () => {
    expect(formatWhen(at(11), now, "en-GB")).toBe("Wed 11 Nov");
    expect(formatWhen(at(2), now, "en-GB")).toBe("2 Nov");
    expect(formatWhen(at(20, 9, 15, 11, 2025), now, "en-GB")).toBe("20 Dec 2025");
  });

  it("is empty for a missing time", () => {
    expect(formatWhen(Number.NaN, now)).toBe("");
  });
});
