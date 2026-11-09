import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_LOADED, type RowSource } from "../grid/rowSource";
import { JsonGraphPanel } from "./JsonGraphPanel";

const rows = [
  { id: 1, user: { name: "Alice", city: "Berlin" }, items: [{ sku: "a" }, { sku: "b" }] },
  { id: 2, user: { name: "Bob", city: "Oslo" }, items: [{ sku: "c" }] },
];

/** Rows like the grid's: nested columns as objects (Arrow structs and lists). */
class FakeSource implements RowSource {
  readonly rowCount = rows.length;
  readonly columns = [
    { name: "id", kind: "integer" as const, type: "Int64", nullable: true },
    { name: "user", kind: "json" as const, type: "Struct", nullable: true },
    { name: "items", kind: "json" as const, type: "List", nullable: true },
  ];
  getValue(row: number, col: number): unknown {
    const r = rows[row]!;
    return [r.id, r.user, r.items][col];
  }
  ensure() {}
  load() {
    return Promise.resolve();
  }
  subscribe() {
    return () => {};
  }
  dispose() {}
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-id='${id}']`);

describe("JSON graph view", () => {
  afterEach(() => clearMocks());

  it("draws the selected record as cards and moves between records", async () => {
    const onRecordChange = vi.fn();
    render(
      <JsonGraphPanel
        tabId="t1"
        title="orders.json"
        source={new FakeSource()}
        view={{}}
        record={0}
        onRecordChange={onRecordChange}
      />,
    );
    const graph = await screen.findByRole("group", { name: "Graph of record 1" });
    expect(within(graph).getByRole("button", { name: /^Record 1/ })).toBeInTheDocument();
    expect(card("$.user")).toHaveTextContent('name: "Alice"');
    expect(card("$.items")).toHaveTextContent("2 items");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next record" }));
    expect(onRecordChange).toHaveBeenLastCalledWith(1);
    await screen.findByRole("group", { name: "Graph of record 2" });
    expect(card("$.user")).toHaveTextContent('name: "Bob"');
    expect(screen.getByRole("button", { name: "Next record" })).toBeDisabled();
  });

  it("shows a value's path and value, collapses branches and finds text", async () => {
    render(
      <JsonGraphPanel tabId="t1" title="o.json" source={new FakeSource()} view={{}} record={0} />,
    );
    await screen.findByRole("group", { name: "Graph of record 1" });
    const user = userEvent.setup();
    await user.click(within(card("$.user")!).getByRole("button", { name: /city/ }));
    const details = screen.getByRole("complementary", { name: "Details" });
    expect(details).toHaveTextContent("$.user.city");
    expect(details).toHaveTextContent('"Berlin"');
    // Collapse the items: their cards go.
    await user.click(screen.getByRole("button", { name: "Collapse items" }));
    expect(card("$.items[0]")).toBeNull();
    // A search opens the way to its matches and counts them.
    await user.type(screen.getByRole("searchbox", { name: "Find in the graph" }), "sku");
    expect(card("$.items[0]")).not.toBeNull();
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });

  it("shows the whole file's structure from the engine", async () => {
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "json_shape") asked.push((args as { deep?: boolean }).deep);
      if (cmd === "json_shape")
        return {
          rows: 2,
          elapsedMs: 1,
          fields: [
            {
              name: "id",
              kind: "value",
              type: "integer",
              present: 2,
              avgLen: null,
              maxLen: null,
              sql: '"id"',
              children: [],
            },
            {
              name: "user",
              kind: "object",
              type: "object",
              present: 1,
              avgLen: null,
              maxLen: null,
              sql: '"user"',
              children: [
                {
                  name: "name",
                  kind: "value",
                  type: "text",
                  present: 1,
                  avgLen: null,
                  maxLen: null,
                  sql: null,
                  children: [],
                },
              ],
            },
          ],
        };
      throw new Error(`unexpected ${cmd}`);
    });
    render(
      <JsonGraphPanel
        tabId="t1"
        title="o.json"
        source={new FakeSource()}
        datasetId="ds-1"
        view={{ search: "x" }}
        record={0}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Structure" }));
    await screen.findByRole("group", { name: "Graph of the file's structure" });
    expect(card("$")).toHaveTextContent("2 records");
    expect(card("$.user")).toHaveTextContent("in 50% of records");
    await user.click(within(card("$.user")!).getByRole("button", { name: /^user/ }));
    expect(screen.getByRole("complementary", { name: "Details" })).toHaveTextContent('"user"');
    // The deep count is asked for on demand.
    expect(asked).toEqual([false]);
    await user.click(screen.getByRole("checkbox", { name: "Count keys inside arrays" }));
    await screen.findByRole("group", { name: "Graph of the file's structure" });
    expect(asked).toEqual([false, true]);
  });

  it("filters, adds columns and unnests arrays from the selection", async () => {
    const onFilter = vi.fn();
    const onAddColumns = vi.fn();
    const onUnnest = vi.fn();
    render(
      <JsonGraphPanel
        tabId="t1"
        title="o.json"
        source={new FakeSource()}
        view={{}}
        record={0}
        columns={["id", "user", "items"]}
        onFilter={onFilter}
        onAddColumns={onAddColumns}
        onUnnest={onUnnest}
      />,
    );
    await screen.findByRole("group", { name: "Graph of record 1" });
    const user = userEvent.setup();
    const actions = () => screen.getByRole("group", { name: "Use this" });

    // A value inside an object.
    await user.click(within(card("$.user")!).getByRole("button", { name: /city/ }));
    await user.click(
      within(actions()).getByRole("button", { name: "Only records where user.city = “Berlin”" }),
    );
    expect(onFilter).toHaveBeenLastCalledWith({
      column: "user",
      path: ["city"],
      op: "equals",
      value: "Berlin",
    });
    await user.click(
      within(actions()).getByRole("button", { name: "Only records that have user.city" }),
    );
    expect(onFilter).toHaveBeenLastCalledWith({ column: "user", path: ["city"], op: "notNull" });
    await user.click(within(actions()).getByRole("button", { name: "Add as a column" }));
    expect(onAddColumns).toHaveBeenLastCalledWith([
      { name: "city", expression: `struct_extract("user", 'city')` },
    ]);

    // An object: all its values as columns.
    await user.click(within(card("$.user")!).getByRole("button", { name: /^user/ }));
    await user.click(
      within(actions()).getByRole("button", { name: "Add its 2 values as columns" }),
    );
    expect(onAddColumns.mock.lastCall![0].map((c: { name: string }) => c.name)).toEqual([
      "name",
      "city",
    ]);

    // An array, and a value inside one of its items.
    await user.click(within(card("$.items")!).getByRole("button", { name: /^items/ }));
    await user.click(
      within(actions()).getByRole("button", { name: "Unnest into rows (one row per item)" }),
    );
    expect(onUnnest).toHaveBeenLastCalledWith("items", [], undefined);
    await user.click(within(card("$.items[1]")!).getByRole("button", { name: /sku/ }));
    await user.click(
      within(actions()).getByRole("button", { name: "Unnest $.items into rows first" }),
    );
    expect(onUnnest).toHaveBeenCalledTimes(2);
  });

  it("says when a record can't be read", async () => {
    class Broken extends FakeSource {
      getValue() {
        return NOT_LOADED;
      }
    }
    render(<JsonGraphPanel tabId="t1" title="o.json" source={new Broken()} view={{}} record={0} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Record 1 couldn't be read.");
  });
});
