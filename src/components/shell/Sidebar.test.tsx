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

  it("Show all brings hidden columns back; the last one can't be hidden", async () => {
    const onLayoutChange = vi.fn();
    let layout = setHidden(defaultLayout(["id", "name", "amount"]), "id", true);
    layout = setHidden(layout, "name", true);
    render(<Sidebar tabs={[tab(layout)]} active={tab(layout)} onLayoutChange={onLayoutChange} />);
    expect(screen.getByText("1 of 3 shown")).toBeInTheDocument();
    expect(screen.getByLabelText("Show amount")).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show all" }));
    expect(onLayoutChange.mock.calls[0]![0].hidden).toEqual([]);
  });

  it("asks to open a file when nothing is open", () => {
    render(<Sidebar tabs={[]} />);
    expect(screen.getByText("Open a file to see its columns")).toBeInTheDocument();
  });
});
