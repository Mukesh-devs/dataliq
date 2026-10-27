import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  allCommands,
  matchCommands,
  useCommands,
  useRegisterCommands,
  type Command,
} from "./commands";

const cmd = (id: string, title: string, group = "View", keywords?: string): Command => ({
  id,
  title,
  group,
  keywords,
  run: vi.fn(),
});

const list = [
  cmd("a", "Clear filters"),
  cmd("b", "Filter amount…", "Columns"),
  cmd("c", "Copy selection as CSV", "Copy"),
  cmd("d", "Copy view as SQL", "Copy", "query duckdb"),
];

describe("matchCommands", () => {
  it("returns everything for an empty query", () => {
    expect(matchCommands(list, "  ")).toBe(list);
  });

  it("needs every word, in title, group or keywords, in any case", () => {
    expect(matchCommands(list, "copy sql").map((c) => c.id)).toEqual(["d"]);
    expect(matchCommands(list, "DUCKDB").map((c) => c.id)).toEqual(["d"]);
    expect(matchCommands(list, "columns amount").map((c) => c.id)).toEqual(["b"]);
    expect(matchCommands(list, "nothing")).toEqual([]);
  });

  it("puts titles starting with the query first", () => {
    expect(matchCommands(list, "filter").map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("useRegisterCommands", () => {
  it("registers while mounted and updates with the list", () => {
    const { rerender, unmount } = renderHook(({ c }) => useRegisterCommands("x", c), {
      initialProps: { c: list.slice(0, 1) },
    });
    expect(allCommands(useCommands.getState().sources).map((c) => c.id)).toEqual(["a"]);
    rerender({ c: list.slice(1, 3) });
    expect(allCommands(useCommands.getState().sources).map((c) => c.id)).toEqual(["b", "c"]);
    act(() => unmount());
    expect(useCommands.getState().sources.x).toBeUndefined();
  });
});
