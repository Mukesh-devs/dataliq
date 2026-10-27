import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "../../lib/arrow";
import type { Filter } from "../../lib/view";
import { FilterBar } from "./FilterBar";

const columns: ColumnInfo[] = [
  { name: "name", kind: "text", type: "Utf8", nullable: true },
  { name: "amount", kind: "number", type: "Float64", nullable: true },
  { name: "joined", kind: "date", type: "Date32<DAY>", nullable: true },
];

const filters: Filter[] = [
  { column: "name", op: "contains", value: "ann" },
  { column: "joined", op: "gte", value: "2024-01-01" },
];

function setup(list: Filter[] = filters) {
  const props = {
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    onClear: vi.fn(),
    onAdd: vi.fn(),
  };
  render(<FilterBar filters={list} columns={columns} {...props} />);
  return { ...props, user: userEvent.setup() };
}

describe("FilterBar", () => {
  it("shows a chip per filter that can be edited or removed", async () => {
    const { onEdit, onRemove, onClear, user } = setup();
    const bar = screen.getByRole("toolbar", { name: "Filters" });
    expect(bar).toHaveTextContent('name contains "ann"');
    expect(bar).toHaveTextContent("joined ≥ 2024-01-01");
    await user.click(screen.getByRole("button", { name: 'Edit filter: name contains "ann"' }));
    expect(onEdit).toHaveBeenCalledWith(0, expect.any(HTMLElement));
    await user.click(screen.getByRole("button", { name: "Remove filter: joined ≥ 2024-01-01" }));
    expect(onRemove).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("adds a filter by picking a column", async () => {
    const { onAdd, user } = setup([]);
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.type(screen.getByLabelText("Search columns"), "amo");
    const list = screen.getByRole("list", { name: "Columns" });
    expect(list).toHaveTextContent("amount");
    expect(list).not.toHaveTextContent("name");
    await user.click(screen.getByRole("button", { name: "amount" }));
    expect(onAdd).toHaveBeenCalledWith(columns[1], expect.any(HTMLElement));
  });

  it("Enter picks the first matching column", async () => {
    const { onAdd, user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.type(screen.getByLabelText("Search columns"), "jo{Enter}");
    expect(onAdd).toHaveBeenCalledWith(columns[2], expect.any(HTMLElement));
  });
});

describe("FilterBar sort chips", () => {
  it("shows the sort keys in order; click reverses, × removes", async () => {
    const onSortChange = vi.fn();
    render(
      <FilterBar
        filters={[]}
        columns={columns}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onAdd={vi.fn()}
        sort={[{ column: "joined", descending: true }, { column: "name" }]}
        onSortChange={onSortChange}
      />,
    );
    const user = userEvent.setup();
    expect(screen.getByRole("toolbar")).toHaveTextContent("Sorted by1.joined2.name");
    await user.click(
      screen.getByRole("button", { name: "Sort by joined, descending (click to reverse)" }),
    );
    expect(onSortChange).toHaveBeenLastCalledWith([
      { column: "joined", descending: false },
      { column: "name" },
    ]);
    await user.click(screen.getByRole("button", { name: "Remove sort by name" }));
    expect(onSortChange).toHaveBeenLastCalledWith([{ column: "joined", descending: true }]);
  });
});
