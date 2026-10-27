import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RenameColumn } from "./RenameColumn";

const anchor = { getBoundingClientRect: () => new DOMRect(0, 0, 100, 30) };

describe("RenameColumn", () => {
  it("renames, and resets to the column's own name", async () => {
    const onRename = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <RenameColumn
        column="cust_id"
        current="cust_id"
        anchor={anchor}
        onOpenChange={onOpenChange}
        onRename={onRename}
      />,
    );
    const user = userEvent.setup();
    const input = screen.getByLabelText("Display name");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "Customer{Enter}");
    expect(onRename).toHaveBeenCalledWith("Customer");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(
      <RenameColumn
        column="cust_id"
        current="Customer"
        anchor={anchor}
        onOpenChange={onOpenChange}
        onRename={onRename}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(onRename).toHaveBeenLastCalledWith("cust_id");
  });
});
