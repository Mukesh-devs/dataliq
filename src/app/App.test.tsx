import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "../stores/settings";
import { App } from "./App";

describe("App shell", () => {
  beforeEach(() => {
    act(() => useSettings.setState({ theme: "system", density: "comfortable" }));
  });

  it("renders the layout regions", () => {
    render(<App />);
    expect(screen.getByRole("tablist", { name: "Open files" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Ready");
  });

  it("shows the empty-state drop zone", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Drop a CSV, Parquet, JSON or Excel file" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("main")).getByRole("button", { name: /Open file/ }),
    ).toBeVisible();
    expect(screen.getByText("Files you open will show up here.")).toBeInTheDocument();
  });

  it("applies the theme to <html> and switches it from the status bar", async () => {
    const user = userEvent.setup();
    render(<App />);
    // jsdom has no matchMedia, so "system" resolves to light.
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "Theme: follow system" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "Theme: light" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: dark" })).toBeInTheDocument();
  });

  it("applies the density setting", () => {
    act(() => useSettings.setState({ density: "compact" }));
    render(<App />);
    expect(document.documentElement.dataset.density).toBe("compact");
  });
});
