import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTICE_MS, useNotice } from "../../stores/notice";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  afterEach(() => {
    useNotice.getState().clear();
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
});
