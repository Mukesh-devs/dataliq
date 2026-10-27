import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceInfo } from "../lib/files";
import { useSql } from "../stores/sql";
import type { Tab } from "../stores/tabs";
import { sampleInfo } from "../test/ipc";
import { tableNames, useSqlTables } from "./useSqlTables";

const tab = (id: string, title: string, datasetId?: string): Tab => ({
  id,
  title,
  path: `/data/${title}`,
  options: {},
  status: "ready",
  info: {
    ...(sampleInfo as SourceInfo),
    dataset: datasetId ? { id: datasetId, rowCount: 10 } : null,
  },
});

describe("tableNames", () => {
  it("names tabs with full data, uniquely, in tab order", () => {
    const names = tableNames([
      tab("a", "Sales 2024.csv", "d1"),
      tab("b", "loading.csv"),
      tab("c", "sales-2024.parquet", "d2"),
    ]);
    expect(names.map((n) => [n.name, n.datasetId])).toEqual([
      ["sales_2024", "d1"],
      ["sales_2024_2", "d2"],
    ]);
  });
});

describe("tableNames with chosen names", () => {
  it("keeps chosen names and moves file names out of their way", () => {
    const renamed = { ...tab("b", "orders.csv", "d2"), sqlName: "people" };
    const names = tableNames([
      tab("a", "people.csv", "d1"),
      renamed,
      tab("c", "Current View.csv", "d3"),
    ]);
    // The chosen "people" wins; the file named people becomes people_2, and
    // nothing may be called current_view.
    expect(names.map((n) => n.name)).toEqual(["people_2", "people", "current_view_2"]);
  });
});

describe("useSqlTables", () => {
  afterEach(() => clearMocks());

  it("registers new tables, drops closed ones and lists their columns", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return null;
    });
    const { rerender } = renderHook(({ tabs }) => useSqlTables(tabs, null), {
      initialProps: { tabs: [tab("a", "people.csv", "d1"), tab("b", "orders.csv", "d2")] },
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      ["register_table", { datasetId: "d1", name: "people" }],
      ["register_table", { datasetId: "d2", name: "orders" }],
    ]);
    expect(useSql.getState().tables).toEqual([
      { name: "people", columns: ["id", "name"], tabId: "a", current: false },
      { name: "orders", columns: ["id", "name"], tabId: "b", current: false },
    ]);

    // Closing a tab drops its table; the same tabs again change nothing.
    rerender({ tabs: [tab("b", "orders.csv", "d2")] });
    rerender({ tabs: [tab("b", "orders.csv", "d2")] });
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toEqual(["unregister_table", { name: "people" }]);
    expect(useSql.getState().tables.map((t) => t.name)).toEqual(["orders"]);
  });

  it("points current_view at the active tab's view, then back at the file", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return null;
    });
    const people = tab("a", "people.csv", "d1");
    const filtered: Tab = {
      ...people,
      viewState: { status: "done", requestId: "v", dataset: { id: "view-7", rowCount: 3 } },
    };
    const { rerender } = renderHook(({ tabs, active }) => useSqlTables(tabs, active), {
      initialProps: { tabs: [people], active: "a" as string | null },
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toContainEqual(["register_table", { datasetId: "d1", name: "current_view" }]);
    rerender({ tabs: [filtered], active: "a" });
    await waitFor(() =>
      expect(calls).toContainEqual([
        "register_table",
        { datasetId: "view-7", name: "current_view" },
      ]),
    );
    expect(useSql.getState().tables.find((t) => t.current)?.name).toBe("current_view");
    // No active tab: current_view goes away.
    rerender({ tabs: [filtered], active: null });
    await waitFor(() =>
      expect(calls).toContainEqual(["unregister_table", { name: "current_view" }]),
    );
  });

  it("renaming registers the new name and drops the old one", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return null;
    });
    const people = tab("a", "people.csv", "d1");
    const { rerender } = renderHook(({ tabs }) => useSqlTables(tabs, null), {
      initialProps: { tabs: [people] },
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender({ tabs: [{ ...people, sqlName: "staff" }] });
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.slice(1)).toEqual([
      ["unregister_table", { name: "people" }],
      ["register_table", { datasetId: "d1", name: "staff" }],
    ]);
  });
});
