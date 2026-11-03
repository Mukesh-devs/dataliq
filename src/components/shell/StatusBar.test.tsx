import { act, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTICE_MS, useNotice } from "../../stores/notice";
import { useSelection } from "../../stores/selection";
import { DEFAULT_STATS } from "../../lib/selectionStats";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  afterEach(() => {
    useNotice.getState().clear();
    useSelection.getState().clear();
    useSelection.setState({ shown: DEFAULT_STATS });
    vi.useRealTimers();
  });

  it("shows a cancel button while a query runs", async () => {
    const run = vi.fn();
    render(<StatusBar message="Sorting…" action={{ label: "Cancel", run }} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(run).toHaveBeenCalled();
  });

  it("shows a notice for a few seconds instead of the message", () => {
    vi.useFakeTimers();
    render(<StatusBar message="1,000 rows" />);
    act(() => useNotice.getState().show("Copied 3 rows as CSV"));
    expect(screen.getByRole("status")).toHaveTextContent("Copied 3 rows as CSV");
    act(() => vi.advanceTimersByTime(NOTICE_MS));
    expect(screen.getByRole("status")).toHaveTextContent("1,000 rows");
  });

  it("shows the selection's count, sum, average, min and max and copies one", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<StatusBar message="1,000 rows" />);
    expect(screen.queryByRole("group", { name: "Selection statistics" })).toBeNull();
    act(() =>
      useSelection.getState().setResult({
        rows: 3,
        distinctApprox: false,
        columns: [
          {
            column: "amount",
            kind: "number",
            values: 3,
            empty: 0,
            sum: 1234.5,
            avg: 411.5,
            min: 4.5,
            max: 1000,
            minText: null,
            maxText: null,
            distinct: null,
          },
        ],
      }),
    );
    const group = screen.getByRole("group", { name: "Selection statistics" });
    expect(group).toHaveTextContent("Count:3Sum:1,234.5Average:411.5Min:4.5Max:1,000");
    await userEvent.click(screen.getByRole("button", { name: /Sum:/ }));
    expect(writeText).toHaveBeenCalledWith("1234.5");
    await userEvent.click(screen.getByRole("button", { name: "Copy the statistics" }));
    expect(writeText).toHaveBeenLastCalledWith(
      "Count\t3\nSum\t1234.5\nAverage\t411.5\nMin\t4.5\nMax\t1000",
    );
  });

  it("picks which statistics show", async () => {
    render(<StatusBar message="" />);
    act(() =>
      useSelection.getState().setResult({
        rows: 2,
        distinctApprox: false,
        columns: [
          {
            column: "a",
            kind: "number",
            values: 2,
            empty: 0,
            sum: 3,
            avg: 1.5,
            min: 1,
            max: 2,
            minText: null,
            maxText: null,
            distinct: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Choose selection statistics" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Average/ }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Numerical count/ }));
    expect(useSelection.getState().shown).toEqual(["count", "numbers", "sum", "min", "max"]);
    expect(screen.getByRole("group", { name: "Selection statistics" })).not.toHaveTextContent(
      "Average",
    );
  });

  it("says when a big selection is still being added up", () => {
    render(<StatusBar message="" />);
    act(() => useSelection.getState().setPending());
    expect(screen.getByRole("group", { name: "Selection statistics" })).toHaveTextContent(
      "Adding up…",
    );
  });

  it("shows DuckDB's memory against its limit, and what spilled to disk", async () => {
    mockIPC((cmd) => {
      if (cmd === "engine_memory")
        return { usedBytes: 900 * 2 ** 20, limitBytes: 2 ** 30, spilledBytes: 3 * 2 ** 30 };
      throw new Error(`unexpected ${cmd}`);
    });
    try {
      render(<StatusBar message="" />);
      const memory = await screen.findByRole("img", { name: /DuckDB memory/ });
      expect(memory).toHaveTextContent(/900(\.0)? MB \/ 1(\.0)? GB ?· 3(\.0)? GB on disk/);
      expect(memory).toHaveClass("text-warning");
    } finally {
      clearMocks();
    }
  });

  it("hides the memory when the engine can't say", async () => {
    mockIPC(() => {
      throw new Error("no engine");
    });
    try {
      render(<StatusBar message="" />);
      await act(() => Promise.resolve());
      expect(screen.queryByRole("img", { name: /DuckDB memory/ })).toBeNull();
    } finally {
      clearMocks();
    }
  });
});
