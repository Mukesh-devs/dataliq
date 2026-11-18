import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppSettings } from "../../lib/files";
import { useApp } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { SettingsPage } from "./SettingsPage";

const base: AppSettings = {
  memoryLimitMb: null,
  tempDir: null,
  threads: null,
  cacheEnabled: true,
  cacheMaxGb: 20,
  cacheDir: null,
  smallFileMb: 0,
};

function backend() {
  const saved: AppSettings[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "settings_info")
      return {
        totalMemoryMb: 16384,
        defaultMemoryLimitMb: 8192,
        cores: 8,
        defaultCacheDir: "/home/me/.cache/dataliq",
        defaultTempDir: "/tmp/dataliq",
        settingsFile: "/home/me/.config/dataliq/settings.json",
      };
    if (cmd === "cache_info")
      return { dir: "/c", usedBytes: 0, maxBytes: 20e9, entries: 0, enabled: true };
    if (cmd === "save_settings") {
      const next = (args as { settings: AppSettings }).settings;
      if (next.memoryLimitMb !== null && next.memoryLimitMb < 256)
        throw "The memory limit must be at least 256 MB.";
      saved.push(next);
      return { settings: next, restartNeeded: next.cacheDir !== null };
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return saved;
}

describe("SettingsPage", () => {
  beforeEach(() => {
    act(() => {
      useApp.setState({ settings: base, settingsSection: null });
      useSettings.setState({ density: "comfortable", theme: "system" });
    });
  });
  afterEach(() => clearMocks());

  it("lists the sections and starts in its search box", async () => {
    backend();
    render(<SettingsPage />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "Appearance",
      "Memory and speed",
      "Cache",
      "Export",
      "AI assistants",
      "Updates",
      "File types",
    ]);
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveFocus();
    expect(await screen.findByText(/Saved in/)).toHaveTextContent("settings.json");
  });

  it("applies a list choice at once", async () => {
    backend();
    render(<SettingsPage />);
    await userEvent.selectOptions(screen.getByLabelText("Density"), "compact");
    expect(useSettings.getState().density).toBe("compact");
  });

  it("saves a typed value on Enter, and says under it why one is refused", async () => {
    const saved = backend();
    render(<SettingsPage />);
    const user = userEvent.setup();
    const memory = screen.getByLabelText("Memory limit (MB)");
    await user.type(memory, "100{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 256 MB");
    expect(saved).toHaveLength(0);

    await user.clear(memory);
    await user.type(memory, "4096{Enter}");
    await waitFor(() => expect(saved.at(-1)?.memoryLimitMb).toBe(4096));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useApp.getState().settings?.memoryLimitMb).toBe(4096);
  });

  it("puts the saved value back on Escape", async () => {
    const saved = backend();
    render(<SettingsPage />);
    const user = userEvent.setup();
    const size = screen.getByLabelText("Size limit (GB)");
    await user.clear(size);
    await user.type(size, "99{Escape}");
    expect(size).toHaveValue(20);
    expect(saved).toHaveLength(0);
  });

  it("narrows the settings and sections by the search", async () => {
    backend();
    render(<SettingsPage />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "threads");
    expect(screen.getByLabelText("Worker threads")).toBeInTheDocument();
    expect(screen.queryByLabelText("Density")).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Memory and speed"]);
    // A section's name shows all of it.
    await user.clear(screen.getByRole("searchbox", { name: "Search settings" }));
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "cache");
    expect(screen.getByLabelText("Size limit (GB)")).toBeInTheDocument();
    expect(screen.getByLabelText("Location")).toBeInTheDocument();
    // Nothing found.
    await user.clear(screen.getByRole("searchbox", { name: "Search settings" }));
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "zebra");
    expect(screen.getByText("No settings match “zebra”.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Density")).toBeInTheDocument();
  });
});
