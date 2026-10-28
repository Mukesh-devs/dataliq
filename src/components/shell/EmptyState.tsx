import { Clock, FileUp, FolderOpen } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";

export interface RecentFile {
  path: string;
  name: string;
}

interface EmptyStateProps {
  onOpen: () => void;
  /** A folder of files as one table. */
  onOpenFolder?: () => void;
  recent: RecentFile[];
  onOpenRecent: (path: string) => void;
  /** True while a file is being dragged over the window. */
  dragging?: boolean;
}

/** Shown when no file is open: a large drop zone plus recent files. */
export function EmptyState({
  onOpen,
  onOpenFolder,
  recent,
  onOpenRecent,
  dragging = false,
}: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <div
        data-testid="drop-zone"
        data-dragging={dragging || undefined}
        className={cn(
          "flex w-full max-w-xl flex-col items-center gap-4 rounded-[var(--radius-lg)] border-2 border-dashed px-8 py-14 text-center transition-colors duration-[var(--duration)]",
          dragging ? "border-accent bg-accent-soft" : "border-border-strong",
        )}
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <FileUp className="size-6" aria-hidden />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-fg">Drop a CSV, Parquet, JSON or Excel file</h1>
          <p className="text-fg-muted">
            Compressed .gz files work too, and a whole folder of them opens as one table. Nothing is
            uploaded; everything stays on your computer.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={onOpen}>
            Open file <Kbd shortcut="Mod+O" tone="onAccent" />
          </Button>
          {onOpenFolder && (
            <Button variant="secondary" onClick={onOpenFolder}>
              <FolderOpen className="size-4" aria-hidden /> Open folder
            </Button>
          )}
        </div>
      </div>

      <section aria-labelledby="recent-heading" className="w-full max-w-xl">
        <h2
          id="recent-heading"
          className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase"
        >
          <Clock className="size-3.5" aria-hidden /> Recent files
        </h2>
        {recent.length === 0 ? (
          <p className="text-fg-subtle">Files you open will show up here.</p>
        ) : (
          <ul className="flex flex-col">
            {recent.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => onOpenRecent(f.path)}
                  className="flex w-full items-baseline gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left hover:bg-hover"
                >
                  <span className="text-fg">{f.name}</span>
                  <span className="truncate font-mono text-[11px] text-fg-subtle">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
