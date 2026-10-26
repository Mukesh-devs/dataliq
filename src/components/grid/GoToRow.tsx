import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { formatCount } from "../../lib/format";
import { Button } from "../ui/Button";

interface GoToRowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rowCount: number;
  /** Called with a 1-based row number. */
  onGo: (row: number) => void;
}

/** Small "Go to row" box (Ctrl+G). Accepts "1,204,551" or "1204551". */
export function GoToRow({ open, onOpenChange, rowCount, onGo }: GoToRowProps) {
  const [text, setText] = useState("");
  const value = Number(text.replace(/[,_\s]/g, ""));
  const valid = Number.isInteger(value) && value >= 1 && value <= rowCount;
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Go to row"
          sideOffset={4}
          className="z-50 w-72 rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              onGo(value);
              onOpenChange(false);
              setText("");
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-fg-muted">Go to row (1 – {formatCount(rowCount)})</span>
              <input
                autoFocus
                aria-label="Row number"
                inputMode="numeric"
                className="tabular h-8 rounded-[var(--radius)] border border-border bg-bg px-2 font-mono outline-none focus:border-accent"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <Button type="submit" size="sm" variant="primary" disabled={!valid}>
              Go
            </Button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
