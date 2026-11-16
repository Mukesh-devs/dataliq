import { describe, expect, it } from "vitest";
import { matchesQuery, SECTIONS } from "./settingsSearch";

describe("settings search", () => {
  it("needs every word, in any order and case", () => {
    expect(matchesQuery("Memory limit (MB) spill", "LIMIT memory")).toBe(true);
    expect(matchesQuery("Memory limit (MB)", "memory threads")).toBe(false);
    expect(matchesQuery("anything", "  ")).toBe(true);
  });

  it("lists the sections in order", () => {
    expect(SECTIONS.map((s) => s.title)).toEqual([
      "Appearance",
      "Memory and speed",
      "Cache",
      "Export",
      "AI assistants",
      "Updates",
      "File types",
    ]);
  });
});
