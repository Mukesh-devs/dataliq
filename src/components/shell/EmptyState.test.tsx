import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("lists recent files and opens one on click", async () => {
    const onOpenRecent = vi.fn();
    render(
      <EmptyState
        onOpen={() => {}}
        recent={[{ name: "sales.csv.gz", path: "/data/sales.csv.gz" }]}
        onOpenRecent={onOpenRecent}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /sales\.csv\.gz/ }));
    expect(onOpenRecent).toHaveBeenCalledWith("/data/sales.csv.gz");
  });

  it("calls onOpen from the open button", async () => {
    const onOpen = vi.fn();
    render(<EmptyState onOpen={onOpen} recent={[]} onOpenRecent={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Open file/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("highlights the drop zone while dragging", () => {
    render(<EmptyState onOpen={() => {}} recent={[]} onOpenRecent={() => {}} dragging />);
    expect(screen.getByTestId("drop-zone")).toHaveAttribute("data-dragging", "true");
  });
});
