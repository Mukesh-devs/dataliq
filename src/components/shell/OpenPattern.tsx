import * as Popover from "@radix-ui/react-popover";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { isPattern, pickFolder } from "../../lib/files";
import { Button } from "../ui/Button";

interface OpenPatternProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens a folder or a pattern such as `/logs/*.csv.gz` as one table. */
  onOpen: (path: string) => void;
}

const inputClass =
  "h-7 w-full min-w-0 rounded-[var(--radius)] border border-border bg-bg px-2 font-mono text-[12px] text-fg outline-none focus:border-accent";

/** "Open folder or pattern": many files read as one table, with a file column. */
export function OpenPattern({ open, onOpenChange, onOpen }: OpenPatternProps) {
  const [text, setText] = useState("");
  const path = text.trim();
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Open folder or pattern"
          sideOffset={4}
          className="z-50 w-[28rem] rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!path) return;
              onOpen(path);
              onOpenChange(false);
            }}
          >
            <label htmlFor="open-pattern" className="font-medium text-fg">
              Open many files as one table
            </label>
            <div className="flex gap-1">
              <input
                id="open-pattern"
                autoFocus
                className={inputClass}
                placeholder="/data/logs/*.csv.gz"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-7"
                aria-label="Browse for a folder"
                title="Browse for a folder"
                onClick={() =>
                  void pickFolder().then((dir) => {
                    if (dir) setText(dir);
                  })
                }
              >
                <FolderOpen className="size-3.5" aria-hidden />
              </Button>
            </div>
            <p className="text-[12px] text-fg-subtle">
              A folder opens the data files directly in it; a pattern can reach into folders:{" "}
              <code className="font-mono">*</code> any name, <code className="font-mono">**</code>{" "}
              any folders. Columns are matched by name, and a{" "}
              <code className="font-mono">filename</code> column says where each row came from.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" variant="primary" disabled={!path}>
                {path && !isPattern(path) ? "Open folder" : "Open files"}
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
