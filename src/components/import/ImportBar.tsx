import { CircleAlert } from "lucide-react";
import { formatDuration } from "../../lib/format";
import type { ImportState } from "../../stores/tabs";
import { Button } from "../ui/Button";

interface ImportBarProps {
  state: ImportState;
  /** Files smaller than this import silently (no progress bar). */
  quiet: boolean;
  onCancel: () => void;
  onReadDirect: () => void;
  onRetry: () => void;
}

/** Progress, cancel and failure states of the background import. */
export function ImportBar({ state, quiet, onCancel, onReadDirect, onRetry }: ImportBarProps) {
  if (state.status === "running") {
    if (quiet) return null;
    const pct = state.percent === null ? null : Math.max(0, Math.min(100, state.percent));
    return (
      <div
        role="progressbar"
        aria-label="Importing full file"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
        className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 text-[12px] text-fg-muted"
      >
        <span className="shrink-0">
          Importing full file{pct !== null && ` · ${Math.round(pct)}%`} ·{" "}
          {formatDuration(state.elapsedMs)}
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
          {pct === null ? (
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/60" />
          ) : (
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-[var(--duration)]"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
        <span className="shrink-0 text-fg-subtle">You can scroll the preview meanwhile.</span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  if (state.status === "cancelled") {
    return (
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 text-[12px] text-fg-muted">
        <span className="flex-1">Import cancelled. Showing the first rows only.</span>
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Import again
        </Button>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="flex min-h-8 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 py-1 text-[12px]"
      >
        <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
        <span className="flex-1 text-fg-muted">{state.error} Showing the first rows only.</span>
        {state.errorKind === "low-disk" && (
          <Button size="sm" variant="secondary" onClick={onReadDirect}>
            Read directly
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return null;
}
