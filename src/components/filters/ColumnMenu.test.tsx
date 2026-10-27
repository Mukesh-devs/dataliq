import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SortKey } from "../../lib/view";
import { ColumnMenu } from "./ColumnMenu";

const anchor = { getBoundingClientRect: () => new DOMRect(10, 10, 100, 30) };

function setup(sort: SortKey[]) {
  const props = { onOpenChange: vi.fn(), onSort: vi.fn(), onFilter: vi.fn() };
  render(<ColumnMenu column="amount" anchor={anchor} sort={sort} {...props} />);
  return { ...props, user: userEvent.setup() };
}

describe("ColumnMenu", () => {
  it("sorts by the column alone", async () => {
    const { onSort, onOpenChange, user } = setup([{ column: "name" }]);
    expect(screen.getByRole("menu", { name: "amount column" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sort ascending" })).toHaveFocus();
    await user.click(screen.getByRole("menuitem", { name: "Sort descending" }));
    expect(onSort).toHaveBeenCalledWith([{ column: "amount", descending: true }]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("adds to or removes from a multi-column sort", async () => {
    const first = setup([{ column: "name" }]);
    await first.user.click(screen.getByRole("menuitem", { name: "Add to sort" }));
    expect(first.onSort).toHaveBeenCalledWith([{ column: "name" }, { column: "amount" }]);
  });

  it("removes the column from the sort and opens the filter", async () => {
    const { onSort, onFilter, user } = setup([{ column: "name" }, { column: "amount" }]);
    expect(screen.queryByRole("menuitem", { name: "Add to sort" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Remove from sort" }));
    expect(onSort).toHaveBeenCalledWith([{ column: "name" }]);
    await user.click(screen.getByRole("menuitem", { name: "Filter…" }));
    expect(onFilter).toHaveBeenCalled();
  });

  it("arrow keys move between items", async () => {
    const { user } = setup([]);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Sort descending" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Filter…" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Sort ascending" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Filter…" })).toHaveFocus();
  });
});

describe("ColumnMenu column management", () => {
  it("pins, hides, renames and auto-fits", async () => {
    const extra = {
      onPin: vi.fn(),
      onHide: vi.fn(),
      onRename: vi.fn(),
      onAutoFit: vi.fn(),
    };
    const props = { onOpenChange: vi.fn(), onSort: vi.fn(), onFilter: vi.fn() };
    const { rerender } = render(
      <ColumnMenu column="amount" anchor={anchor} sort={[]} pinned={false} {...props} {...extra} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "Pin to the left" }));
    expect(extra.onPin).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("menuitem", { name: "Hide column" }));
    expect(extra.onHide).toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(extra.onRename).toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "Auto-fit width" }));
    expect(extra.onAutoFit).toHaveBeenCalled();
    // A pinned column offers Unpin; the last shown column can't be hidden.
    rerender(
      <ColumnMenu
        column="amount"
        anchor={anchor}
        sort={[]}
        pinned
        {...props}
        {...extra}
        onHide={undefined}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "Unpin column" }));
    expect(extra.onPin).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("menuitem", { name: "Hide column" })).not.toBeInTheDocument();
  });
});
