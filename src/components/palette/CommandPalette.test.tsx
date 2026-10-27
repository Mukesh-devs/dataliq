import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCommands, type Command } from "../../stores/commands";
import { CommandPalette } from "./CommandPalette";

function setup(initialQuery?: string) {
  const runs: string[] = [];
  const make = (id: string, title: string, group: string, shortcut?: string): Command => ({
    id,
    title,
    group,
    shortcut,
    run: () => runs.push(id),
  });
  useCommands.setState({
    sources: {
      app: [make("open", "Open file…", "File", "Ctrl+O")],
      file: [
        make("csv", "Copy selection as CSV", "Copy"),
        make("md", "Copy selection as Markdown table", "Copy"),
        make("sql", "Copy view as SQL", "Copy"),
      ],
    },
  });
  const onOpenChange = vi.fn();
  render(<CommandPalette open onOpenChange={onOpenChange} initialQuery={initialQuery} />);
  return { runs, onOpenChange };
}

const options = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("CommandPalette", () => {
  afterEach(() => useCommands.setState({ sources: {} }));

  it("lists every command with its group and shortcut", () => {
    setup();
    expect(options()).toEqual([
      "Open file…FileCtrl+O",
      "Copy selection as CSVCopy",
      "Copy selection as Markdown tableCopy",
      "Copy view as SQLCopy",
    ]);
    expect(screen.getByRole("combobox", { name: "Search commands" })).toHaveFocus();
  });

  it("filters as you type, moves with arrows and runs on Enter", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { runs, onOpenChange } = setup();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.keyboard("copy sel");
    expect(options()).toHaveLength(2);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    vi.runAllTimers();
    expect(runs).toEqual(["md"]);
    vi.useRealTimers();
  });

  it("starts from the given text (Shift+Ctrl+C shows the copy choices)", () => {
    setup("Copy ");
    expect(options()).toHaveLength(3);
  });

  it("says when nothing matches, and runs on click", async () => {
    const { runs } = setup();
    const user = userEvent.setup();
    await user.keyboard("zzz");
    expect(screen.getByText("No matching commands")).toBeInTheDocument();
    await user.clear(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /Copy view as SQL/ }));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toEqual(["sql"]);
  });
});
