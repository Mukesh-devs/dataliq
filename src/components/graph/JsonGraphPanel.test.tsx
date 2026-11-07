import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RowSource } from "../grid/rowSource";
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
  getValue(row: number, col: number) {
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
    mockIPC((cmd) => {
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
  });
});
