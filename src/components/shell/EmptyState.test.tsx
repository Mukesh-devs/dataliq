import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState, type RecentFile } from "./EmptyState";

const files = (n: number): RecentFile[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `file${i + 1}.csv`,
    path: `/data/file${i + 1}.csv`,
    openedAt: Date.now() - i * 60_000,
  }));

const recentList = () =>
  within(screen.getByRole("region", { name: "Recent files" })).queryAllByRole("listitem");

describe("EmptyState", () => {
  it("lists recent files as name, path and time, and opens one on click", async () => {
    const onOpenRecent = vi.fn();
    render(
      <EmptyState
        onOpen={() => {}}
        recent={[{ name: "sales.csv.gz", path: "/data/sales.csv.gz", openedAt: Date.now() }]}
        onOpenRecent={onOpenRecent}
      />,
    );
    const [row] = recentList();
    expect(row).toHaveTextContent("sales.csv.gz");
    expect(row).toHaveTextContent("/data/sales.csv.gz");
    expect(row).toHaveTextContent(/Today, /);
    await userEvent.click(within(row!).getByRole("button", { name: /sales\.csv\.gz/ }));
    expect(onOpenRecent).toHaveBeenCalledWith("/data/sales.csv.gz");
  });

  it("shows the last five, then the rest on Show more", async () => {
    render(<EmptyState onOpen={() => {}} recent={files(8)} onOpenRecent={() => {}} />);
    expect(recentList()).toHaveLength(5);
    expect(screen.getByText("5 of 8")).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "Show 3 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(recentList()).toHaveLength(8);
    expect(recentList()[7]).toHaveTextContent("file8.csv");
    await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(recentList()).toHaveLength(5);
  });

  it("has no Show more for five files or fewer", () => {
    render(<EmptyState onOpen={() => {}} recent={files(5)} onOpenRecent={() => {}} />);
    expect(recentList()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /Show/ })).not.toBeInTheDocument();
  });

  it("removes one recent file, or clears the list", async () => {
    const onRemoveRecent = vi.fn();
    const onClearRecent = vi.fn();
    render(
      <EmptyState
        onOpen={() => {}}
        recent={files(2)}
        onOpenRecent={() => {}}
        onRemoveRecent={onRemoveRecent}
        onClearRecent={onClearRecent}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove file2.csv from recent files" }),
    );
    expect(onRemoveRecent).toHaveBeenCalledWith("/data/file2.csv");
    await userEvent.click(screen.getByRole("button", { name: "Clear list" }));
    expect(onClearRecent).toHaveBeenCalledOnce();
  });

  it("says where recent files will show, with nothing to clear", () => {
    render(
      <EmptyState onOpen={() => {}} recent={[]} onOpenRecent={() => {}} onClearRecent={() => {}} />,
    );
    expect(screen.getByText("Files you open will show up here.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear list" })).not.toBeInTheDocument();
  });

  it("offers the quick actions", async () => {
    const actions = {
      onOpen: vi.fn(),
      onOpenFolder: vi.fn(),
      onConnectDatabase: vi.fn(),
      onOpenUrl: vi.fn(),
    };
    render(<EmptyState {...actions} recent={[]} onOpenRecent={() => {}} />);
    const quick = screen.getByRole("region", { name: "Quick actions" });
    await userEvent.click(within(quick).getByRole("button", { name: /Open file/ }));
    await userEvent.click(within(quick).getByRole("button", { name: /Open folder/ }));
    await userEvent.click(within(quick).getByRole("button", { name: /Connect database/ }));
    await userEvent.click(within(quick).getByRole("button", { name: /Open URL/ }));
    for (const fn of Object.values(actions)) expect(fn).toHaveBeenCalledOnce();
    expect(within(quick).getByRole("button", { name: /Open file/ })).toHaveTextContent("Ctrl+O");
  });

  it("opens the sample dataset", async () => {
    const onOpenSample = vi.fn();
    render(
      <EmptyState
        onOpen={() => {}}
        onOpenSample={onOpenSample}
        recent={[]}
        onOpenRecent={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Try a sample dataset/ }));
    expect(onOpenSample).toHaveBeenCalledOnce();
  });

  it("highlights the drop zone while dragging", () => {
    render(<EmptyState onOpen={() => {}} recent={[]} onOpenRecent={() => {}} dragging />);
    expect(screen.getByTestId("drop-zone")).toHaveAttribute("data-dragging", "true");
  });
});
