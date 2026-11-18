import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  FileUp,
  FolderOpen,
  Globe,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { formatWhen } from "../../lib/format";
import { Kbd } from "../ui/Kbd";
import { Tips } from "./Tips";

export interface RecentFile {
  path: string;
  name: string;
  /** When it was last opened (ms since the epoch). */
  openedAt?: number;
}

/** Recent files shown before "Show more". */
export const RECENT_SHOWN = 5;

interface EmptyStateProps {
  onOpen: () => void;
  /** A folder of files as one table. */
  onOpenFolder?: () => void;
  onConnectDatabase?: () => void;
  onOpenUrl?: () => void;
  /** Opens the sample dataset. */
  onOpenSample?: () => void;
  recent: RecentFile[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent?: (path: string) => void;
  onClearRecent?: () => void;
  /** True while a file is being dragged over the window. */
  dragging?: boolean;
}

const headingClass =
  "flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase";

function QuickAction({
  icon: Icon,
  title,
  detail,
  shortcut,
  primary = false,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  shortcut?: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex min-w-0 flex-col items-start gap-0.5 rounded-[var(--radius-lg)] border bg-bg p-3.5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors duration-[var(--duration)] hover:bg-hover",
        primary ? "border-accent/45" : "border-border hover:border-border-strong",
      )}
    >
      <span
        className={cn(
          "mb-2 flex size-[34px] items-center justify-center rounded-[8px]",
          primary ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg-muted",
        )}
      >
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <span className="text-[13.5px] font-semibold text-fg">{title}</span>
      <span className="w-full truncate text-[12px] text-fg-muted">{detail}</span>
      {shortcut && <Kbd shortcut={shortcut} className="absolute top-3.5 right-3" />}
    </button>
  );
}

/**
 * Shown when no file is open: the drop zone, quick actions, recent files and
 * the getting-started tips.
 */
export function EmptyState({
  onOpen,
  onOpenFolder,
  onConnectDatabase,
  onOpenUrl,
  onOpenSample,
  recent,
  onOpenRecent,
  onRemoveRecent,
  onClearRecent,
  dragging = false,
}: EmptyStateProps) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? recent : recent.slice(0, RECENT_SHOWN);
  const hidden = recent.length - RECENT_SHOWN;
  return (
    // Centred with auto margins, not justify-center: when it's taller than the
    // window it scrolls from the top instead of cutting the top off.
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-6">
      <div className="m-auto flex w-full max-w-3xl flex-col">
        <div
          data-testid="drop-zone"
          data-dragging={dragging || undefined}
          className={cn(
            "flex w-full flex-col items-center gap-2.5 rounded-[var(--radius-lg)] border-2 border-dashed px-8 pt-7 pb-5 text-center transition-colors duration-[var(--duration)]",
            dragging ? "border-accent bg-accent-soft" : "border-border-strong",
          )}
        >
          <div className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <FileUp className="size-6" aria-hidden />
          </div>
          <h1 className="mt-1 text-lg font-semibold text-fg">
            Drop a CSV, Parquet, JSON or Excel file
          </h1>
          <p className="text-fg-muted">
            Compressed .gz files work too, and a whole folder of them opens as one table.
            <br />
            Nothing is uploaded; everything stays on your computer.
          </p>
          {onOpenSample && (
            <button
              type="button"
              onClick={onOpenSample}
              className="flex items-center gap-1.5 rounded-[var(--radius)] px-2 py-1 text-accent hover:bg-hover"
            >
              <Sparkles className="size-3.5" aria-hidden /> No file at hand? Try a sample dataset
            </button>
          )}
        </div>

        <section aria-labelledby="quick-heading" className="mt-6">
          <h2 id="quick-heading" className={cn(headingClass, "mb-2.5")}>
            <ArrowRight className="size-3.5" aria-hidden /> Quick actions
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <QuickAction
              icon={FileUp}
              title="Open file"
              detail="CSV, JSON, Parquet, Excel"
              shortcut="Mod+O"
              primary
              onClick={onOpen}
            />
            {onOpenFolder && (
              <QuickAction
                icon={FolderOpen}
                title="Open folder"
                detail="Many files as one table"
                shortcut="Mod+Shift+O"
                onClick={onOpenFolder}
              />
            )}
            {onConnectDatabase && (
              <QuickAction
                icon={Database}
                title="Connect database"
                detail="MySQL or PostgreSQL"
                onClick={onConnectDatabase}
              />
            )}
            {onOpenUrl && (
              <QuickAction
                icon={Globe}
                title="Open URL"
                detail="HTTPS or S3 link"
                onClick={onOpenUrl}
              />
            )}
          </div>
        </section>

        <section aria-labelledby="recent-heading" className="mt-6">
          <div className="mb-1.5 flex items-center justify-between">
            <h2 id="recent-heading" className={headingClass}>
              <Clock className="size-3.5" aria-hidden /> Recent files
            </h2>
            {onClearRecent && recent.length > 0 && (
              <button
                type="button"
                onClick={onClearRecent}
                className="rounded-[var(--radius)] px-1.5 py-0.5 text-[12px] font-medium text-fg-muted hover:bg-hover hover:text-fg"
              >
                Clear list
              </button>
            )}
          </div>
          {recent.length === 0 ? (
            <p className="px-2 text-fg-subtle">Files you open will show up here.</p>
          ) : (
            <>
              <ul className="flex flex-col">
                {shown.map((f) => (
                  <li
                    key={f.path}
                    className="group grid h-8 grid-cols-[minmax(0,1fr)_1.5rem] items-center rounded-[var(--radius)] hover:bg-hover focus-within:bg-hover"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRecent(f.path)}
                      title={f.path}
                      className="grid h-full min-w-0 grid-cols-[12.5rem_minmax(0,1fr)_7rem] items-center pl-2 text-left focus-visible:outline-none"
                    >
                      <span className="truncate pr-4 font-medium text-accent">{f.name}</span>
                      <span className="truncate pr-4 text-fg">{f.path}</span>
                      <span className="text-right text-[12px] text-fg-subtle">
                        {f.openedAt ? formatWhen(f.openedAt) : ""}
                      </span>
                    </button>
                    {onRemoveRecent && (
                      <button
                        type="button"
                        onClick={() => onRemoveRecent(f.path)}
                        aria-label={`Remove ${f.name} from recent files`}
                        title="Remove from the list"
                        className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-fg-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-active hover:text-fg"
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {hidden > 0 && (
                <div className="mt-0.5 flex items-center justify-between pr-1">
                  <button
                    type="button"
                    onClick={() => setShowAll(!showAll)}
                    aria-expanded={showAll}
                    className="flex items-center gap-1.5 rounded-[var(--radius)] px-2 py-1 font-medium text-accent hover:bg-hover"
                  >
                    {showAll ? (
                      <>
                        <ChevronUp className="size-3.5" aria-hidden /> Show fewer
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3.5" aria-hidden /> Show {hidden} more
                      </>
                    )}
                  </button>
                  <span className="text-[12px] text-fg-subtle">
                    {shown.length} of {recent.length}
                  </span>
                </div>
              )}
            </>
          )}
        </section>

        <Tips />
      </div>
    </div>
  );
}
