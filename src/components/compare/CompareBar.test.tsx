import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CompareInfo } from "../../lib/compare";
import { CompareBar } from "./CompareBar";

const compare: CompareInfo = {
  dataset: { id: "diff-1", rowCount: 7 },
  columns: [],
  leftRows: 7,
  rightRows: 8,
  added: 2,
  removed: 1,
  changed: 4,
  same: 2,
  duplicateLeft: 2,
  duplicateRight: 3,
  compared: ["qty", "price", "note"],
  onlyLeft: [],
  onlyRight: [],
  retyped: [],
  changes: [
    { name: "price", rows: 1 },
    { name: "note", rows: 2 },
  ],
  elapsedMs: 12,
  left: "orders_v1.csv",
  right: "orders_v2.csv",
  keys: ["id"],
};

describe("CompareBar", () => {
  it("shows the counts; each one shows only those rows", async () => {
    const onShow = vi.fn();
    const { rerender } = render(<CompareBar compare={compare} onShow={onShow} />);
    const bar = screen.getByRole("region", { name: "Comparison" });
    expect(bar).toHaveTextContent("7 → 8 rows, matched by “id”:");
    expect(bar).toHaveTextContent("2 the same");
    expect(bar).toHaveTextContent("Changed: price 1 · note 2");
    expect(bar).toHaveTextContent("matched in order of appearance");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "2 added" }));
    expect(onShow).toHaveBeenLastCalledWith("added");
    rerender(<CompareBar compare={compare} shown="added" onShow={onShow} />);
    expect(screen.getByRole("button", { name: "2 added" })).toHaveAttribute("aria-pressed", "true");
    // Pressed again: all rows.
    await user.click(screen.getByRole("button", { name: "2 added" }));
    expect(onShow).toHaveBeenLastCalledWith(undefined);
    await user.click(screen.getByRole("button", { name: "4 changed" }));
    expect(onShow).toHaveBeenLastCalledWith("changed");
  });
});
