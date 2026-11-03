import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FormatColumn } from "./FormatColumn";

const anchor = { getBoundingClientRect: () => new DOMRect(0, 0, 1, 1) };

describe("FormatColumn", () => {
  it("adds a highlight rule once it has a value, and a colour scale from the range", async () => {
    const onChange = vi.fn();
    const loadRange = vi.fn(() => Promise.resolve({ min: 0, max: 900 }));
    render(
      <FormatColumn
        column="minutes"
        kind="number"
        format={undefined}
        anchor={anchor}
        onOpenChange={() => {}}
        onChange={onChange}
        loadRange={loadRange}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add a rule" }));
    // Not applied before it has a value.
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    await user.type(screen.getByLabelText("Rule 1: value"), "300");
    expect(onChange).toHaveBeenLastCalledWith({
      rules: [{ op: "gt", value: "300", color: "red" }],
    });
    await user.click(screen.getByRole("checkbox", { name: /Shade every number/ }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        rules: [{ op: "gt", value: "300", color: "red" }],
        scale: { min: 0, max: 900, color: "green" },
      }),
    );
    expect(screen.getByText("0 → 900")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear formatting" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("offers text tests and no scale for text columns", async () => {
    render(
      <FormatColumn
        column="status"
        kind="text"
        format={{ rules: [{ op: "contains", value: "fail", color: "amber" }] }}
        anchor={anchor}
        onOpenChange={() => {}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Rule 1: test")).toHaveValue("contains");
    expect(screen.queryByRole("option", { name: "greater than" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Shade/ })).toBeNull();
  });
});
