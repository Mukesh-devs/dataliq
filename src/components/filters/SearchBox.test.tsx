import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBox } from "./SearchBox";

describe("SearchBox", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const input = () => screen.getByLabelText("Search text columns");

  it("searches when typing stops", () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} debounceMs={300} />);
    fireEvent.change(input(), { target: { value: "sm" } });
    fireEvent.change(input(), { target: { value: "smith" } });
    act(() => vi.advanceTimersByTime(299));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("smith");
  });

  it("Enter searches at once; Escape and × clear", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchBox value="" onChange={onChange} />);
    fireEvent.change(input(), { target: { value: "ann" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("ann");
    act(() => vi.advanceTimersByTime(1000));
    expect(onChange).toHaveBeenCalledTimes(1); // the pending debounce was dropped
    rerender(<SearchBox value="ann" onChange={onChange} />);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveValue("");
    expect(onChange).toHaveBeenLastCalledWith("");
    rerender(<SearchBox value="" onChange={onChange} />);
    fireEvent.change(input(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input()).toHaveValue("");
  });

  it("follows the view when the search is changed elsewhere", () => {
    const { rerender } = render(<SearchBox value="old" onChange={() => {}} />);
    expect(input()).toHaveValue("old");
    rerender(<SearchBox value="" onChange={() => {}} />);
    expect(input()).toHaveValue("");
  });
});
