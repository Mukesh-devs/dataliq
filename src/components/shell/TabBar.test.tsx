import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../../stores/tabs";
import { TabBar } from "./TabBar";

const tab = (id: string, title: string, extra: Partial<Tab> = {}): Tab => ({
  id,
  title,
  path: `/d/${title}`,
  options: {},
  status: "ready",
  ...extra,
});

describe("TabBar", () => {
  it("selects, closes and middle-click closes tabs", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={[tab("1", "a.csv"), tab("2", "b.csv", { status: "loading" })]}
        activeId="1"
        onSelect={onSelect}
        onClose={onClose}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("tab", { name: "a.csv" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "b.csv" }));
    expect(onSelect).toHaveBeenCalledWith("2");
    // The close button is for the mouse; Delete on the tab closes it too.
    const [close] = screen.getAllByTitle(/^Close/);
    await userEvent.click(close!);
    expect(onClose).toHaveBeenCalledWith("1");
    onClose.mockClear();
    screen.getByRole("tab", { name: "a.csv" }).focus();
    await userEvent.keyboard("{Delete}");
    expect(onClose).toHaveBeenCalledWith("1");
    fireEvent(
      screen.getByRole("tab", { name: "b.csv" }),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onClose).toHaveBeenCalledWith("2");
  });
});
