import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "../../lib/arrow";
import type { Filter, ValueList } from "../../lib/view";
import { FilterEditor } from "./FilterEditor";

const col = (name: string, kind: ColumnInfo["kind"]): ColumnInfo => ({
  name,
  kind,
  type: "",
  nullable: true,
});

const anchor = { getBoundingClientRect: () => new DOMRect(10, 10, 100, 30) };

function setup(column: ColumnInfo, extra: Partial<Parameters<typeof FilterEditor>[0]> = {}) {
  const onApply = vi.fn<(f: Filter) => void>();
  const onOpenChange = vi.fn();
  render(
    <FilterEditor
      column={column}
      anchor={anchor}
      open
      onOpenChange={onOpenChange}
      onApply={onApply}
      {...extra}
    />,
  );
  return { onApply, onOpenChange, user: userEvent.setup() };
}

describe("FilterEditor", () => {
  it("builds a text filter", async () => {
    const { onApply, onOpenChange, user } = setup(col("name", "text"));
    expect(screen.getByRole("heading", { name: "Filter name" })).toBeInTheDocument();
    expect(screen.getByLabelText("Condition")).toHaveValue("contains");
    await user.type(screen.getByLabelText("Value"), "ann");
    await user.click(screen.getByLabelText("Match case"));
    await user.click(screen.getByLabelText("Exclude matching rows"));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({
      column: "name",
      op: "contains",
      value: "ann",
      caseSensitive: true,
      not: true,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("checks numbers and offers number conditions", async () => {
    const { onApply, user } = setup(col("amount", "number"));
    const options = [...screen.getByLabelText<HTMLSelectElement>("Condition").options].map(
      (o) => o.textContent,
    );
    expect(options).toEqual([
      "equals",
      "between",
      "greater than",
      "at least",
      "less than",
      "at most",
      "is one of",
      "is null",
      "is not null",
    ]);
    await user.selectOptions(screen.getByLabelText("Condition"), "range");
    await user.type(screen.getByLabelText("From"), "x");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent('"x" is not a number.');
    expect(onApply).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "10");
    await user.type(screen.getByLabelText("To"), "20.5");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({ column: "amount", op: "range", min: 10, max: 20.5 });
  });

  it("uses date wording and the last-N-days input", async () => {
    const { onApply, user } = setup(col("joined", "date"));
    const select = screen.getByLabelText<HTMLSelectElement>("Condition");
    expect([...select.options].map((o) => o.textContent)).toContain("before");
    await user.selectOptions(select, "lastDays");
    await user.clear(screen.getByLabelText("Days"));
    await user.type(screen.getByLabelText("Days"), "7");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({ column: "joined", op: "lastDays", days: 7 });
  });

  it("edits an existing filter and can remove it", async () => {
    const onRemove = vi.fn();
    const { onApply, user } = setup(col("active", "boolean"), {
      filter: { column: "active", op: "equals", value: true },
      onRemove,
    });
    expect(screen.getByLabelText("Condition")).toHaveValue("isTrue");
    expect(screen.queryByLabelText("Exclude matching rows")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Condition"), "isFalse");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({ column: "active", op: "equals", value: false });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("picks values from the value list, with counts and search", async () => {
    const load = vi.fn(async (search: string): Promise<ValueList> => ({
      values: [
        { value: "Berlin", count: 1200 },
        { value: "Paris", count: 30 },
        { value: null, count: 4 },
        { value: "", count: 2 },
      ].filter((v) => !search || (v.value ?? "").toLowerCase().includes(search)),
      truncated: !search,
    }));
    const { onApply, user } = setup(col("city", "text"), { loadValues: load });
    await user.selectOptions(screen.getByLabelText("Condition"), "in");
    const list = await screen.findByRole("list", { name: "Values" });
    await waitFor(() => expect(list).toHaveTextContent("Berlin1,200"));
    expect(list).toHaveTextContent("null4");
    expect(list).toHaveTextContent("(empty)2");
    expect(screen.getByText(/showing the most common values/)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Berlin/));
    await user.click(screen.getByLabelText(/null/));
    await user.type(screen.getByLabelText("Search values"), "par");
    await waitFor(() => expect(load).toHaveBeenLastCalledWith("par"));
    await waitFor(() => expect(list).not.toHaveTextContent("Berlin"));
    await user.click(screen.getByLabelText(/Paris/));
    expect(screen.getByText(/3 selected/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({
      column: "city",
      op: "in",
      values: ["Berlin", null, "Paris"],
    });
  });

  it("disables the value list until the data is ready", () => {
    setup(col("city", "text"));
    const option = [...screen.getByLabelText<HTMLSelectElement>("Condition").options].find(
      (o) => o.value === "in",
    );
    expect(option?.disabled).toBe(true);
  });
});
