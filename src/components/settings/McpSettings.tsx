import { Copy, FolderPlus, X } from "lucide-react";
import { pickFolder, type AppSettings, type SettingsInfo } from "../../lib/files";
import { claudeCodeCommand, desktopConfig } from "../../lib/mcp";
import { useNotice } from "../../stores/notice";
import { Button, IconButton } from "../ui/Button";

type McpFields = Pick<AppSettings, "mcpEnabled" | "mcpFolders" | "mcpAllowExport">;

/**
 * Settings › AI assistants: lets an assistant (Claude Desktop, Claude Code or
 * any MCP client) read the data in chosen folders through `dataliq mcp`.
 */
export function McpSettings({
  value,
  onChange,
  info,
}: {
  value: McpFields;
  onChange: (changes: McpFields) => void;
  info: SettingsInfo | null;
}) {
  const notice = useNotice((s) => s.show);
  const enabled = value.mcpEnabled ?? false;
  const folders = value.mcpFolders ?? [];
  const command = info?.mcpCommand;
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(
      () => notice(`Copied ${what}`),
      (e: unknown) => notice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`),
    );
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-fg">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ mcpEnabled: e.target.checked })}
        />
        Let AI assistants read data in these folders (MCP)
      </label>
      <p className="text-[12px] text-fg-muted">
        An assistant such as Claude can list, describe and query your files with DataLiq, read-only,
        on this computer. It sees only the folders below, can’t change your files, and every call is
        logged.
      </p>
      <ul aria-label="Shared folders" className="flex flex-col gap-1">
        {folders.length === 0 && <li className="text-[12px] text-fg-subtle">No folders yet.</li>}
        {folders.map((f) => (
          <li key={f} className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={f}>
              {f}
            </code>
            <IconButton
              label={`Stop sharing ${f}`}
              className="size-6"
              onClick={() => onChange({ mcpFolders: folders.filter((x) => x !== f) })}
            >
              <X className="size-3.5" aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void pickFolder().then((dir) => {
              if (dir && !folders.includes(dir)) onChange({ mcpFolders: [...folders, dir] });
            })
          }
        >
          <FolderPlus className="size-3.5" aria-hidden /> Add a folder…
        </Button>
      </div>
      <label className="flex items-center gap-2 text-fg">
        <input
          type="checkbox"
          checked={value.mcpAllowExport ?? false}
          onChange={(e) => onChange({ mcpAllowExport: e.target.checked })}
        />
        Also let them save query results as new files in these folders
      </label>
      {command && (
        <div className="flex flex-col gap-1 rounded-[var(--radius)] border border-border bg-surface p-2">
          <span className="text-[12px] text-fg-muted">
            Add DataLiq to Claude Desktop (Settings › Developer › Edit config):
          </span>
          <pre
            aria-label="Claude Desktop configuration"
            className="overflow-x-auto font-mono text-[11px] text-fg"
          >
            {desktopConfig(command)}
          </pre>
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => copy(desktopConfig(command), "the configuration")}
            >
              <Copy className="size-3" aria-hidden /> Copy configuration
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => copy(claudeCodeCommand(command), "the Claude Code command")}
            >
              <Copy className="size-3" aria-hidden /> Copy Claude Code command
            </Button>
          </div>
          {info?.mcpLog && (
            <span className="text-[11px] text-fg-subtle">
              Calls are logged in <code className="font-mono">{info.mcpLog}</code>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
