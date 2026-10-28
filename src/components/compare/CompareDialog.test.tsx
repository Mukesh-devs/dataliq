import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompareDialog, type CompareSide } from "./CompareDialog";

const anchor = { getBoundingClientRect: () => new DOMRect(10, 10, 100, 30) };
const col = (name: string) => ({ name, type: "VARCHAR" });
const v1: CompareSide = { tabId: "t1", title: "orders_v1.csv", columns: [col("id"), col("qty")] };
const v2: CompareSide = { tabId: "t2", title: "orders_v2.csv", columns: [col("qty"), col("id")] };
const other: CompareSide = { tabId: "t3", title: "people.csv", columns: [col("name"), col("qty")] };

function setup(onCompare = vi.fn(() => Promise.resolve())) {
  const onOpenChange = vi.fn();
  render(
    <CompareDialog
      anchor={anchor}
      current={v1}
      others={[v2, other]}
      onOpenChange={onOpenChange}
      onCompare={onCompare}
    />,
  );
  return { onCompare, onOpenChange, user: userEvent.setup() };
}

describe("CompareDialog", () => {
  it("compares this file with another by the suggested key", async () => {
    const { onCompare, onOpenChange, user } = setup();
    expect(screen.getByRole("checkbox", { name: "id" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "qty" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Compare" }));
    expect(onCompare).toHaveBeenCalledWith("t1", "t2", ["id"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("swaps before and after, and takes several keys", async () => {
    const { onCompare, user } = setup();
    await user.click(screen.getByRole("button", { name: "Swap before and after" }));
    await user.click(screen.getByRole("checkbox", { name: "qty" }));
    await user.click(screen.getByRole("button", { name: "Compare" }));
    expect(onCompare).toHaveBeenCalledWith("t2", "t1", ["id", "qty"]);
  });

  it("another file brings its own keys; no key, no comparing; errors stay", async () => {
    const onCompare = vi.fn(() => Promise.reject(new Error("Both files need the key column")));
    const { onOpenChange, user } = setup(onCompare);
    await user.selectOptions(screen.getByLabelText("Other file"), "t3");
    // people.csv shares only qty, which doesn't look like a key: it is taken anyway.
    expect(screen.getByRole("checkbox", { name: "qty" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "id" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "qty" }));
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "qty" }));
    await user.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Both files need the key column");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
