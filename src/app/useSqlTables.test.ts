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

describe("useSqlTables", () => {
  afterEach(() => clearMocks());

  it("registers new tables, drops closed ones and lists their columns", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return null;
    });
    const { rerender } = renderHook(({ tabs }) => useSqlTables(tabs), {
      initialProps: { tabs: [tab("a", "people.csv", "d1"), tab("b", "orders.csv", "d2")] },
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      ["register_table", { datasetId: "d1", name: "people" }],
      ["register_table", { datasetId: "d2", name: "orders" }],
    ]);
    expect(useSql.getState().tables).toEqual([
      { name: "people", columns: ["id", "name"] },
      { name: "orders", columns: ["id", "name"] },
    ]);

    // Closing a tab drops its table; the same tabs again change nothing.
    rerender({ tabs: [tab("b", "orders.csv", "d2")] });
    rerender({ tabs: [tab("b", "orders.csv", "d2")] });
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toEqual(["unregister_table", { name: "people" }]);
    expect(useSql.getState().tables.map((t) => t.name)).toEqual(["orders"]);
  });
});
