import { describe, expect, it } from "vitest";
import { formatShortcut } from "./platform";

describe("formatShortcut", () => {
  it("uses symbols on macOS", () => {
    expect(formatShortcut("Mod+K", true)).toBe("⌘K");
    expect(formatShortcut("Mod+Shift+C", true)).toBe("⌘⇧C");
  });

  it("uses words joined by + elsewhere", () => {
    expect(formatShortcut("Mod+K", false)).toBe("Ctrl+K");
    expect(formatShortcut("Mod+Shift+C", false)).toBe("Ctrl+Shift+C");
  });
});
