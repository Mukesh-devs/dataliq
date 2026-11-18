import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeIpc } from "../../lib/arrow";
import { defaultLayout, setHidden, setPinned, rename } from "../../lib/layout";
import { useSettings } from "../../stores/settings";
import { useSql } from "../../stores/sql";
import type { Tab } from "../../stores/tabs";
import { ipcBytes } from "../../test/ipc";
import { Sidebar } from "./Sidebar";

const preview = decodeIpc(ipcBytes({ id: [1], name: ["a"], amount: [1.5] }));

function tab(layout = defaultLayout(["id", "name", "amount"])): Tab {
  return {
    id: "t1",
    title: "sales.csv",
    path: "/d/sales.csv",
    options: {},
    status: "ready",
    preview,
    layout,
  };
}

describe("Sidebar columns", () => {
  it("lists the active file's columns and shows / hides them", async () => {
    const onLayoutChange = vi.fn();
    const layout = rename(
      setPinned(defaultLayout(["id", "name", "amount"]), "amount", true),
      "id",
      "ID",
    );
    render(<Sidebar tabs={[tab(layout)]} active={tab(layout)} onLayoutChange={onLayoutChange} />);
    const list = screen.getByRole("list", { name: "Columns" });
    // Display order (pinned first) and display names.
    expect(list).toHaveTextContent(/amount.*ID.*name/);
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("3 of 3 shown")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByLabelText("Show name"));
    expect(onLayoutChange.mock.calls[0]![0].hidden).toEqual(["name"]);
  });

  it("Show all columns brings hidden columns back; the last one can't be hidden", async () => {
    const onLayoutChange = vi.fn();
    let layout = setHidden(defaultLayout(["id", "name", "amount"]), "id", true);
    layout = setHidden(layout, "name", true);
    render(<Sidebar tabs={[tab(layout)]} active={tab(layout)} onLayoutChange={onLayoutChange} />);
    expect(screen.getByText("1 of 3 shown")).toBeInTheDocument();
    expect(screen.getByLabelText("Show amount")).toBeDisabled();
    const all = screen.getByLabelText("Show all columns");
    expect(all).toHaveAttribute("aria-checked", "mixed");
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    await userEvent.setup().click(all);
    expect(onLayoutChange.mock.calls[0]![0].hidden).toEqual([]);
  });

  it("unselects all columns but the first", async () => {
    const onLayoutChange = vi.fn();
    render(<Sidebar tabs={[tab()]} active={tab()} onLayoutChange={onLayoutChange} />);
    const all = screen.getByLabelText("Show all columns");
    expect(all).toBeChecked();
    await userEvent.setup().click(all);
    expect(onLayoutChange.mock.calls[0]![0].hidden).toEqual(["name", "amount"]);
  });

  it("inverts the shown columns", async () => {
    const onLayoutChange = vi.fn();
    const layout = setHidden(defaultLayout(["id", "name", "amount"]), "name", true);
    render(<Sidebar tabs={[tab(layout)]} active={tab(layout)} onLayoutChange={onLayoutChange} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Invert" }));
    expect(onLayoutChange.mock.calls[0]![0].hidden).toEqual(["id", "amount"]);
  });

  it("finds columns and selects only the matching ones", async () => {
    const names = ["call_id", "dial_in", "dial_out", "duration", "a", "b", "c", "d"];
    const wide = decodeIpc(ipcBytes(Object.fromEntries(names.map((n) => [n, [1]]))));
    const t = { ...tab(defaultLayout(names)), preview: wide };
    const onLayoutChange = vi.fn();
    render(<Sidebar tabs={[t]} active={t} onLayoutChange={onLayoutChange} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Find columns" }), "dial");
    const list = screen.getByRole("list", { name: "Columns" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("2 of 2 matching")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Show all matching columns"));
    expect(onLayoutChange.mock.calls[0]![0].hidden).toEqual(["dial_in", "dial_out"]);
    await user.clear(screen.getByRole("searchbox", { name: "Find columns" }));
    await user.type(screen.getByRole("searchbox", { name: "Find columns" }), "zzz");
    expect(screen.getByText(/No columns match/)).toBeInTheDocument();
  });

  it("shows only the filtered columns", async () => {
    const onLayoutChange = vi.fn();
    const t: Tab = {
      ...tab(),
      view: { filters: [{ column: "amount", op: "gt", value: 1 } as never] },
    };
    render(<Sidebar tabs={[t]} active={t} onLayoutChange={onLayoutChange} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Filtered" }));
    expect(onLayoutChange.mock.calls[0]![0].hidden).toEqual(["id", "name"]);
  });

  it("marks each column's type", () => {
    render(<Sidebar tabs={[tab()]} active={tab()} />);
    // Test IPC numbers are doubles.
    expect(screen.getAllByTitle("Number")).toHaveLength(2);
    expect(screen.getByTitle("Text")).toBeInTheDocument();
  });

  it("switches to a file's tab from the Files list", async () => {
    const onSelect = vi.fn();
    const other = { ...tab(), id: "t2", title: "calls.csv" };
    render(<Sidebar tabs={[tab(), other]} active={tab()} onSelect={onSelect} />);
    const files = screen.getByRole("list", { name: "Files" });
    expect(files.querySelector("[aria-current]")).toHaveTextContent("sales.csv");
    await userEvent.setup().click(screen.getByRole("button", { name: "calls.csv" }));
    expect(onSelect).toHaveBeenCalledWith("t2");
  });

  it("asks to open a file when nothing is open", () => {
    render(<Sidebar tabs={[]} />);
    expect(screen.getByText("Open a file to see its columns")).toBeInTheDocument();
  });
});

describe("Sidebar sections", () => {
  beforeEach(() => useSettings.setState({ collapsed: {} }));

  it("fold away from their titles and stay folded", async () => {
    const user = userEvent.setup();
    render(<Sidebar tabs={[tab()]} active={tab()} />);
    const columns = screen.getByRole("button", { name: "Columns" });
    expect(columns).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list", { name: "Columns" })).toBeInTheDocument();

    await user.click(columns);
    expect(columns).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Columns" })).not.toBeInTheDocument();
    // The other section is unaffected.
    expect(screen.getByRole("list", { name: "Files" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("dataliq.settings")!).state.collapsed).toEqual({
      columns: true,
    });

    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.queryByRole("list", { name: "Files" })).not.toBeInTheDocument();
    await user.click(columns);
    expect(screen.getByRole("list", { name: "Columns" })).toBeInTheDocument();
  });

  it("show their arrow only when the pointer is near or the keyboard is on them", () => {
    render(<Sidebar tabs={[]} />);
    const arrow = screen.getByTestId("files-chevron");
    expect(arrow).toHaveClass("opacity-0");
    expect(arrow.getAttribute("class")).toMatch(/group-hover\/section:opacity-100/);
    expect(arrow.getAttribute("class")).toMatch(/group-focus-within\/section:opacity-100/);
  });

  it("keeps the cache section as it is", () => {
    render(<Sidebar tabs={[]} />);
    expect(screen.queryByRole("button", { name: "Cache" })).not.toBeInTheDocument();
  });
});

describe("Sidebar columns into SQL", () => {
  afterEach(() => useSql.setState({ open: false, editor: null }));

  const fakeEditor = () => ({
    runnable: () => ({ script: "", base: 0 }),
    replace: vi.fn(),
    insert: vi.fn(),
    showDropAt: vi.fn(() => false),
    dropAt: vi.fn(() => false),
    endDrop: vi.fn(),
    focus: vi.fn(),
  });

  it("Ctrl+click inserts the column at the cursor instead of hiding it", async () => {
    const editor = fakeEditor();
    useSql.setState({ open: true, editor });
    const onLayoutChange = vi.fn();
    const layout = defaultLayout(["id", "Order Date"]);
    const t = { ...tab(layout), preview: decodeIpc(ipcBytes({ id: [1], "Order Date": ["x"] })) };
    render(<Sidebar tabs={[t]} active={t} onLayoutChange={onLayoutChange} />);
    const user = userEvent.setup();
    await user.keyboard("{Control>}");
    await user.click(screen.getByText("Order Date"));
    await user.keyboard("{/Control}");
    expect(editor.insert).toHaveBeenCalledWith('"Order Date"');
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter on a column's checkbox inserts it too", async () => {
    const editor = fakeEditor();
    useSql.setState({ open: true, editor });
    render(<Sidebar tabs={[tab()]} active={tab()} onLayoutChange={() => {}} />);
    screen.getByLabelText("Show amount").focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(editor.insert).toHaveBeenCalledWith("amount");
  });
});
