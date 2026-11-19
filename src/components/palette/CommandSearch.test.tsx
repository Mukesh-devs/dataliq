import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCommands, type Command } from "../../stores/commands";
import { CommandSearch } from "./CommandSearch";

const runs: string[] = [];
const make = (id: string, title: string, group: string, shortcut?: string): Command => ({
  id,
  title,
  group,
  shortcut,
  run: () => runs.push(id),
});

/** The search as the app holds it, opened by the same keys (Ctrl+K, Shift+Ctrl+C). */
function Harness() {
  const [request, setRequest] = useState<{ query: string } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === "k") setRequest({ query: "" });
      if (e.shiftKey && e.key === "C") setRequest({ query: "Copy " });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button type="button">Before</button>
      <CommandSearch
        request={request}
        onOpen={(query) => setRequest((r) => r ?? { query })}
        onClose={() => setRequest(null)}
      />
    </>
  );
}

function setup() {
  runs.length = 0;
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
  render(<Harness />);
  return screen.getByRole("combobox", { name: "Search commands" });
}

const options = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("CommandSearch", () => {
  afterEach(() => useCommands.setState({ sources: {} }));

  it("is the box you type in: the list drops down under it, with no second box", async () => {
    const box = setup();
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(options()).toEqual([]);
    await userEvent.click(box);
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(options()).toEqual([
      "Open file…FileCtrl+O",
      "Copy selection as CSVCopy",
      "Copy selection as Markdown tableCopy",
      "Copy view as SQLCopy",
    ]);
  });

  it("filters as you type, moves with arrows and runs on Enter, then gives the focus back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const box = setup();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    screen.getByRole("button", { name: "Before" }).focus();
    await user.keyboard("{Control>}k{/Control}");
    expect(box).toHaveFocus();
    await user.keyboard("copy sel");
    expect(options()).toHaveLength(2);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    vi.runAllTimers();
    expect(runs).toEqual(["md"]);
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(box).toHaveValue("");
    expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
    vi.useRealTimers();
  });

  it("starts from the given text (Shift+Ctrl+C shows the copy choices)", async () => {
    const box = setup();
    await userEvent.keyboard("{Control>}{Shift>}C{/Shift}{/Control}");
    expect(box).toHaveValue("Copy ");
    expect(options()).toHaveLength(3);
  });

  it("keeps what's typed when typing opens it, clears with ✕, closes with Escape", async () => {
    const box = setup();
    await userEvent.click(box);
    await userEvent.keyboard("{Escape}");
    expect(box).toHaveAttribute("aria-expanded", "false");
    box.focus();
    await userEvent.keyboard("zzz");
    expect(box).toHaveValue("zzz");
    expect(screen.getByText("No matching commands")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    await userEvent.click(screen.getByRole("option", { name: /Copy view as SQL/ }));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toEqual(["sql"]);
  });
});

describe("CommandSearch, after running an action with nowhere to go back to", () => {
  it("opens again on a click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const box = setup();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Control>}k{/Control}open{Enter}");
    vi.runAllTimers();
    expect(runs).toEqual(["open"]);
    expect(box).toHaveAttribute("aria-expanded", "false");
    await user.click(box);
    expect(box).toHaveAttribute("aria-expanded", "true");
    vi.useRealTimers();
  });
});
