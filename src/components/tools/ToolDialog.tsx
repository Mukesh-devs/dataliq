import * as Popover from "@radix-ui/react-popover";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTicker } from "../../lib/useTicker";
import { formatElapsed, useJobs } from "../../stores/jobs";
import { Button } from "../ui/Button";

interface ToolDialogProps {
  title: string;
  onClose: () => void;
  /** Runs the tool; rejects with a message to show. Closes when it resolves. */
  onRun: () => Promise<void>;
  runLabel: string;
  /** Why it can't run yet (the button is disabled and says so). */
  blocked?: string;
  children: ReactNode;
  width?: string;
}

export const fieldClass =
  "h-7 w-full min-w-0 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-fg outline-none focus:border-accent";

export const labelClass = "text-[11px] text-fg-subtle";

/** A small dialog for a data tool: a form, Run and the error if it fails. */
export function ToolDialog({
  title,
  onClose,
  onRun,
  runLabel,
  blocked,
  children,
  width = "w-96",
}: ToolDialogProps) {
  // When Run was pressed (the queries started since then are this run's).
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const running = runningSince !== null;
  const [error, setError] = useState<string>();
  const now = useTicker(running);
  const run = async () => {
    if (blocked || running) return;
    setRunningSince(performance.now());
    setError(undefined);
    try {
      await onRun();
      onClose();
    } catch (e) {
      if ((e as { kind?: string }).kind === "cancelled") {
        setError("Stopped.");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningSince(null);
    }
  };
  const stop = () => runningSince !== null && useJobs.getState().cancelSince(runningSince);
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label={title}
          sideOffset={4}
          collisionPadding={8}
          className={`z-50 flex max-h-[80vh] ${width} max-w-[92vw] flex-col gap-3 overflow-y-auto rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]`}
        >
          <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            {children}
            {error && (
              <p role="alert" className="flex gap-1.5 text-fg-muted">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
                <span className="min-w-0 break-words">{error}</span>
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              {blocked && <span className="mr-auto text-fg-subtle">{blocked}</span>}
              {running && (
                <span className="tabular mr-auto text-fg-subtle" aria-live="off">
                  Running… {formatElapsed(Math.max(0, now - runningSince))}
                </span>
              )}
              {running ? (
                <Button size="sm" variant="ghost" onClick={stop}>
                  Stop
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              )}
              <Button type="submit" size="sm" variant="primary" disabled={!!blocked || running}>
                {running && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
                {runLabel}
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** "Only the rows the view shows" (filters, search, sort), when the view has any. */
export function ViewToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-fg">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      Only the rows the view shows (filters and search)
    </label>
  );
}
