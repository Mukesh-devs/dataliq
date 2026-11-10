import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcBytes, sampleInfo } from "../test/ipc";
import { defaultLayout, setHidden, setWidth } from "../lib/layout";
import type { Filter } from "../lib/view";
import { describeChange, useTabs } from "./tabs";

const nameFilter: Filter = { column: "name", op: "contains", value: "a" };
const settle = () => new Promise((r) => setTimeout(r, 0));
const tab = () => useTabs.getState().tabs[0]!;

function backend() {
  const views: unknown[] = [];
  let n = 0;
  mockIPC(
    (cmd, a) => {
      const args = a as Record<string, unknown>;
      switch (cmd) {
        case "open_file":
          return { ...sampleInfo, dataset: { id: "ds1", rowCount: 1000, cached: true } };
        case "preview_file":
          return ipcBytes({ id: [1, 2, 3], name: ["a", "b", null] });
        case "open_view":
          views.push(args.spec);
          return { dataset: { id: `view-${++n}`, rowCount: 10 }, totalRows: 1000, elapsedMs: 1 };
        default:
          return true;
      }
    },
    { shouldMockEvents: true },
  );
  return views;
}

describe("tabs store: undo and redo of the view", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));
  afterEach(() => {
    clearMocks();
    vi.useRealTimers();
  });

  it("undoes and redoes filters, sort and search, applying each again", async () => {
    const views = backend();
    await useTabs.getState().openPath("/data/sales.csv");
    await settle();
    const id = tab().id;
    const { setView, undoView, redoView } = useTabs.getState();
    await setView(id, { filters: [nameFilter] });
    await setView(id, { filters: [nameFilter], sort: [{ column: "id", descending: true }] });
    await setView(id, {
      filters: [nameFilter],
      sort: [{ column: "id", descending: true }],
      search: "x",
    });
    expect(await undoView(id)).toBe("the search");
    expect(tab().view).toEqual({
      filters: [nameFilter],
      sort: [{ column: "id", descending: true }],
    });
    expect(await undoView(id)).toBe("the sort");
    expect(await undoView(id)).toBe("the filters");
    expect(tab().view).toBeUndefined();
    expect(await undoView(id)).toBeNull();
    expect(await redoView(id)).toBe("the filters");
    expect(tab().view).toEqual({ filters: [nameFilter] });
    expect(views.at(-1)).toEqual({ filters: [nameFilter] });
    // A new change drops what was undone.
    await setView(id, { search: "y" });
    expect(await redoView(id)).toBeNull();
  });

  it("undoes column changes; a resize drag is one step", async () => {
    backend();
    await useTabs.getState().openPath("/data/sales.csv");
    await settle();
    const id = tab().id;
    const { setLayout, undoView } = useTabs.getState();
    const cols = ["id", "name"];
    const hidden = setHidden(defaultLayout(cols), "name", true);
    setLayout(id, hidden);
    vi.useFakeTimers();
    for (const w of [100, 110, 120, 130]) setLayout(id, setWidth(hidden, "id", w));
    vi.advanceTimersByTime(2000);
    expect(tab().viewHistory?.past).toHaveLength(2);
    expect(await undoView(id)).toBe("the columns");
    expect(tab().layout).toEqual(hidden);
    expect(await undoView(id)).toBe("the columns");
    expect(tab().layout).toBeUndefined();
  });

  it("says plainly what several changes were", () => {
    expect(describeChange({}, { view: { search: "a" } })).toBe("the search");
    expect(
      describeChange({}, { view: { search: "a", sort: [{ column: "x", descending: false }] } }),
    ).toBe("the sort and the search");
    expect(describeChange({ view: {} }, { view: {} })).toBe("the view");
  });
});
