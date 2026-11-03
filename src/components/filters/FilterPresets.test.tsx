import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Filter } from "../../lib/view";
import { missingColumns, usePresets } from "../../stores/presets";
import { FilterPresets } from "./FilterPresets";

const connected = { column: "status", op: "equals", value: "connected" } as unknown as Filter;
const longCalls = { column: "minutes", op: "gt", value: 10 } as unknown as Filter;

describe("filter presets", () => {
  afterEach(() => act(() => usePresets.setState({ presets: [] })));

  it("saves the view's filters, search and sort, replacing by name", () => {
    const { save } = usePresets.getState();
    act(() => save({ name: " Long calls ", filters: [longCalls], sort: [{ column: "day" }] }));
    act(() => save({ name: "long CALLS", filters: [connected, longCalls] }));
    const [p] = usePresets.getState().presets;
    expect(usePresets.getState().presets).toHaveLength(1);
    expect(p).toMatchObject({ name: "long CALLS", filters: [connected, longCalls] });
    expect(missingColumns(p!, ["status"])).toEqual(["minutes"]);
  });

  it("applies a preset to a file with its columns, not to others", async () => {
    act(() =>
      usePresets.getState().save({
        name: "Connected",
        filters: [connected],
        search: "acc1",
        sort: [{ column: "minutes", descending: true }],
      }),
    );
    act(() =>
      usePresets
        .getState()
        .save({ name: "Other file", filters: [{ ...connected, column: "zone" }] }),
    );
    const onApply = vi.fn();
    render(
      <FilterPresets view={{ filters: [] }} columns={["status", "minutes"]} onApply={onApply} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter presets" }));
    expect(screen.getByRole("button", { name: /^Other file/ })).toBeDisabled();
    expect(screen.getByText("Needs zone")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Connected/ }));
    expect(onApply).toHaveBeenCalledWith({
      filters: [connected],
      search: "acc1",
      sort: [{ column: "minutes", descending: true }],
    });
  });

  it("saves the current filters under a name", async () => {
    render(
      <FilterPresets view={{ filters: [longCalls] }} columns={["minutes"]} onApply={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter presets" }));
    await user.type(screen.getByLabelText("Preset name"), "Over 10 minutes");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(usePresets.getState().presets.map((p) => p.name)).toEqual(["Over 10 minutes"]);
    expect(screen.getByRole("list", { name: "Saved filters" })).toHaveTextContent("1 filter");
  });

  it("has nothing to save without filters", async () => {
    render(<FilterPresets view={{}} columns={[]} onApply={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Filter presets" }));
    expect(screen.getByLabelText("Preset name")).toBeDisabled();
  });
});
