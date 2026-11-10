import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VirtualList } from "./VirtualList";

describe("VirtualList", () => {
  it("renders only the rows in view and follows the scroll", () => {
    render(
      <VirtualList
        aria-label="Columns"
        count={5000}
        rowHeight={24}
        height={240}
        renderRow={(i) => <span>row {i}</span>}
      />,
    );
    const items = () => screen.getAllByRole("listitem");
    expect(items().length).toBeLessThan(30);
    expect(screen.getByText("row 0")).toBeTruthy();
    expect(items()[0]!.getAttribute("aria-setsize")).toBe("5000");
    fireEvent.scroll(screen.getByTestId("virtual-list"), { target: { scrollTop: 24 * 4000 } });
    expect(screen.queryByText("row 0")).toBeNull();
    expect(screen.getByText("row 4000").closest("li")!.getAttribute("aria-posinset")).toBe("4001");
  });
});
