import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import mainConfig from "../../../src-tauri/tauri.conf.json";
import windowsConfig from "../../../src-tauri/tauri.windows.conf.json";
import { TitleBar } from "./TitleBar";
import { WindowControls, type WindowApi } from "./WindowControls";

const panels = { left: true, right: false, bottom: false };

function fakeWindow(maximized = false) {
  let resized: (() => void) | undefined;
  const api: WindowApi & { state: { maximized: boolean }; resize: () => void } = {
    state: { maximized },
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => api.state.maximized),
    onResized: vi.fn(async (handler: () => void) => {
      resized = handler;
      return () => (resized = undefined);
    }),
    resize: () => resized?.(),
  };
  return api;
}

describe("TitleBar", () => {
  it("is one row with the menus, the search in the middle and the panels (own title bar)", async () => {
    const onTogglePanel = vi.fn();
    const { container } = render(
      <TitleBar
        own
        menu={<nav aria-label="Menu bar">File Edit</nav>}
        search={<input aria-label="Search commands" />}
        panels={panels}
        onTogglePanel={onTogglePanel}
      />,
    );
    const bar = screen.getByRole("banner");
    // The empty parts move the window; the buttons in it don't.
    expect(bar).toHaveAttribute("data-tauri-drag-region");
    expect(container.querySelectorAll("[data-tauri-drag-region]").length).toBeGreaterThan(3);
    expect(screen.getByRole("textbox", { name: "Search commands" })).not.toHaveAttribute(
      "data-tauri-drag-region",
    );
    expect(screen.getByRole("navigation", { name: "Menu bar" })).toBeInTheDocument();
    // The tabs live in their own row, not here.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Show SQL panel/ }));
    expect(onTogglePanel).toHaveBeenCalledWith("bottom");
  });

  it("shares its row with the tabs under the system's title bar, and doesn't move the window", () => {
    render(
      <TitleBar
        own={false}
        tabs={<div role="tablist" aria-label="Open files" />}
        panels={panels}
        onTogglePanel={() => {}}
      />,
    );
    expect(screen.getByRole("tablist", { name: "Open files" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).not.toHaveAttribute("data-tauri-drag-region");
    expect(screen.queryByRole("group", { name: "Window" })).not.toBeInTheDocument();
  });
});

describe("WindowControls", () => {
  it("minimises, maximises and closes the window, and shows Restore when maximised", async () => {
    const win = fakeWindow();
    render(<WindowControls api={win} />);
    await userEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(win.minimize).toHaveBeenCalledOnce();
    await userEvent.click(await screen.findByRole("button", { name: "Maximize" }));
    expect(win.toggleMaximize).toHaveBeenCalledOnce();
    win.state.maximized = true;
    await act(async () => win.resize());
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(win.close).toHaveBeenCalledOnce();
  });
});

describe("the Windows window settings", () => {
  it("are the main window's, without the system's title bar", () => {
    const [main] = mainConfig.app.windows;
    const [win] = windowsConfig.app.windows;
    expect(win).toEqual({ ...main, decorations: false });
  });
});
