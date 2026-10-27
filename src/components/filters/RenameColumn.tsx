import * as Popover from "@radix-ui/react-popover";
import { useMemo, useState } from "react";
import { Button } from "../ui/Button";
import type { Anchor } from "./FilterEditor";

interface RenameColumnProps {
  column: string;
  /** The current display name. */
  current: string;
  anchor: Anchor;
  onOpenChange: (open: boolean) => void;
  /** New display name; the column's own name (or empty) resets it. */
  onRename: (name: string) => void;
}

/** Popover to change a column's display name (the data keeps its name). */
export function RenameColumn({
  column,
  current,
  anchor,
  onOpenChange,
  onRename,
}: RenameColumnProps) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const [name, setName] = useState(current);
  return (
    <Popover.Root open onOpenChange={onOpenChange}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<Anchor>} />
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={`Rename ${column}`}
          className="z-50 w-72 rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(name);
              onOpenChange(false);
            }}
          >
            <label className="flex flex-col gap-1 text-fg-muted">
              Display name
              <input
                aria-label="Display name"
                autoFocus
                className="h-7 rounded-[var(--radius)] border border-border bg-bg px-2 text-fg outline-none focus:border-accent"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <p className="text-[12px] text-fg-subtle">
              Only changes how the column is shown; filters, sorting and SQL keep{" "}
              <span className="font-mono">{column}</span>.
            </p>
            <div className="flex justify-end gap-2">
              {current !== column && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    onRename(column);
                    onOpenChange(false);
                  }}
                >
                  Reset
                </Button>
              )}
              <Button type="submit" variant="primary">
                Rename
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
