import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsInfo } from "../../lib/files";
import { claudeCodeCommand, desktopConfig } from "../../lib/mcp";
import { McpSettings } from "./McpSettings";

const info = {
  mcpCommand: "/opt/DataLiq/dataliq",
  mcpLog: "/home/me/.local/share/app.dataliq.desktop/mcp-log.jsonl",
} as SettingsInfo;

describe("AI assistant settings", () => {
  afterEach(() => clearMocks());

  it("turns access on, adds and removes folders, and allows exports", async () => {
    mockIPC((cmd) => {
      if (cmd === "plugin:dialog|open") return "/data/cdr";
      throw new Error(`unexpected ${cmd}`);
    });
    const onChange = vi.fn();
    render(
      <McpSettings
        value={{ mcpEnabled: false, mcpFolders: ["/data/old"], mcpAllowExport: false }}
        onChange={onChange}
        info={info}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Let AI assistants read data/ }));
    expect(onChange).toHaveBeenLastCalledWith({ mcpEnabled: true });
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ mcpFolders: ["/data/old", "/data/cdr"] }),
    );
    await user.click(screen.getByRole("button", { name: "Stop sharing /data/old" }));
    expect(onChange).toHaveBeenLastCalledWith({ mcpFolders: [] });
    await user.click(screen.getByRole("checkbox", { name: /save query results/ }));
    expect(onChange).toHaveBeenLastCalledWith({ mcpAllowExport: true });
    expect(screen.getByLabelText("Claude Desktop configuration")).toHaveTextContent(
      '"command": "/opt/DataLiq/dataliq"',
    );
    expect(screen.getByText(info.mcpLog!)).toBeInTheDocument();
  });

  it("writes the client configuration", () => {
    expect(JSON.parse(desktopConfig("C:\\Program Files\\DataLiq\\dataliq.exe"))).toEqual({
      mcpServers: {
        dataliq: { command: "C:\\Program Files\\DataLiq\\dataliq.exe", args: ["mcp"] },
      },
    });
    expect(claudeCodeCommand("/opt/d")).toBe('claude mcp add dataliq -- "/opt/d" mcp');
  });
});
