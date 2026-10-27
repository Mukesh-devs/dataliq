import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { tableNameProblem } from "../../lib/sql";
import { Button } from "../ui/Button";

interface RenameTableProps {
  /** The table's name now. */
  current: string;
  /** The name it gets from its file (what Reset goes back to). */
  fromFile: string;
  /** Names of the other tables. */
  taken: string[];
  onRename: (name: string | undefined) => void;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

/** Popover to choose a file's SQL table name. */
export function RenameTable({
  current,
  fromFile,
  taken,
  onRename,
  onOpenChange,
  children,
}: RenameTableProps) {
  const [name, setName] = useState(current);
  const problem = name === current ? null : tableNameProblem(name.trim(), taken);
  return (
    <Popover.Root open onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={4}
          collisionPadding={8}
          aria-label={`Rename table ${current}`}
          className="z-50 w-72 rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (problem) return;
              const next = name.trim();
              onRename(next === fromFile ? undefined : next);
              onOpenChange(false);
            }}
          >
            <label className="flex flex-col gap-1 text-fg-muted">
              Table name
              <input
                aria-label="Table name"
                autoFocus
                spellCheck={false}
                className="h-7 rounded-[var(--radius)] border border-border bg-bg px-2 font-mono text-fg outline-none focus:border-accent"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={(e) => e.target.select()}
              />
            </label>
            {problem && (
              <p role="alert" className="text-[12px] text-danger">
                {problem}
              </p>
            )}
            <div className="flex justify-end gap-2">
              {current !== fromFile && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    onRename(undefined);
                    onOpenChange(false);
                  }}
                >
                  Reset
                </Button>
              )}
              <Button type="submit" variant="primary" disabled={!!problem}>
                Rename
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
