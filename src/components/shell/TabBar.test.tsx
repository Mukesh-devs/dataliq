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

describe("TabBar with Settings open", () => {
  it("shows a Settings tab after the files', in the arrows' order", async () => {
    const onSelect = vi.fn();
    const settings = { active: false, onSelect: vi.fn(), onClose: vi.fn() };
    render(
      <TabBar
        tabs={[tab("1", "a.csv"), tab("2", "b.csv")]}
        activeId="2"
        onSelect={onSelect}
        onClose={() => {}}
        onOpen={() => {}}
        settings={settings}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["a.csv", "b.csv", "Settings"]);
    screen.getByRole("tab", { name: "b.csv" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(settings.onSelect).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(settings.onSelect).toHaveBeenCalledTimes(2);
    screen.getByRole("tab", { name: "Settings" }).focus();
    await userEvent.keyboard("{Delete}");
    expect(settings.onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks Settings as the selected tab while it's in front", () => {
    render(
      <TabBar
        tabs={[tab("1", "a.csv")]}
        activeId="1"
        onSelect={() => {}}
        onClose={() => {}}
        onOpen={() => {}}
        settings={{ active: true, onSelect: () => {}, onClose: () => {} }}
      />,
    );
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "a.csv" })).toHaveAttribute("aria-selected", "false");
  });
});

describe("TabBar icons", () => {
  it("shows each file's kind, and a spinner while it opens", () => {
    render(
      <TabBar
        tabs={[
          tab("1", "Master.csv"),
          tab("2", "accounts.json"),
          tab("3", "Report.xlsx", { info: { format: "xlsx" } as never }),
          tab("4", "calls.parquet", { status: "loading" }),
        ]}
        activeId="1"
        onSelect={() => {}}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    const kinds = screen
      .getAllByRole("tab")
      .map((t) => t.querySelector("[data-file-kind]")?.getAttribute("data-file-kind") ?? "busy");
    expect(kinds).toEqual(["csv", "json", "excel", "busy"]);
  });
});
