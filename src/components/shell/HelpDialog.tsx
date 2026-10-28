import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";
import { modKey } from "../../lib/platform";
import { allCommands, useCommands } from "../../stores/commands";
import { useEngine } from "../../stores/engine";
import { Button } from "../ui/Button";

export type HelpTopic = "about" | "shortcuts";

/** Shortcuts that aren't commands: what the mouse and the grid do. */
const GESTURES: [string, string][] = [
  ["Copy the selected cells (TSV)", `${modKey}+C`],
  ["Sort by a column / add a sort key", "Click / Shift+click a header"],
  ["Close a tab", "Middle-click it"],
  ["Menu bar (Windows, Linux)", "Alt or F10"],
];

function Shortcuts() {
  const sources = useCommands((s) => s.sources);
  const seen = new Set<string>();
  const rows = allCommands(sources)
    .filter((c) => c.shortcut && !seen.has(c.shortcut) && seen.add(c.shortcut))
    .map((c) => [c.title, c.shortcut!] as [string, string]);
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-semibold text-fg">Keyboard shortcuts</h2>
      <table className="w-full text-[12px]">
        <tbody>
          {[...rows, ...GESTURES].map(([what, keys]) => (
            <tr key={what} className="border-b border-border last:border-0">
              <td className="py-1 pr-4 text-fg">{what}</td>
              <td className="py-1 text-right font-mono text-fg-muted">{keys}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-fg-subtle">
        Every action is also in the command palette ({modKey}+K) and in the menus.
      </p>
    </div>
  );
}

function About() {
  const duckdb = useEngine((s) => s.version);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="font-semibold text-fg">BigView{version && ` ${version}`}</h2>
      <p className="text-fg-muted">
        A fast viewer for big CSV, JSON, Parquet and Excel files, with filters, SQL, charts and
        cleaning. Everything runs on this computer.
      </p>
      <p className="text-[12px] text-fg-subtle">Data engine: DuckDB {duckdb ?? ""}</p>
    </div>
  );
}

/** Help › Keyboard shortcuts and Help › About. */
export function HelpDialog({ topic, onClose }: { topic: HelpTopic | null; onClose: () => void }) {
  return (
    <Popover.Root open={topic !== null} onOpenChange={(o) => !o && onClose()}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label={topic === "about" ? "About BigView" : "Keyboard shortcuts"}
          sideOffset={4}
          className="z-50 flex max-h-[calc(100vh-96px)] w-[min(30rem,calc(100vw-32px))] flex-col gap-3 overflow-y-auto rounded-[var(--radius-lg)] border border-border bg-bg p-4 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          {topic === "about" ? <About /> : <Shortcuts />}
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
