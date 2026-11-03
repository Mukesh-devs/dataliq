import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeIpc } from "../../lib/arrow";
import { defaultLayout, setHidden, setPinned, rename } from "../../lib/layout";
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
