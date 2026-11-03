import { useState } from "react";
import type { CompareSide } from "../compare/CompareDialog";
import { ToolDialog, fieldClass, labelClass } from "./ToolDialog";

interface AppendDialogProps {
  current: CompareSide;
  others: CompareSide[];
  onClose: () => void;
  /** Tabs in order (the current one first) and the name of the source column, if any. */
  onRun: (tabIds: string[], sourceColumn: string | undefined) => Promise<void>;
}

/** Stacks open tabs into one table, columns matched by name. */
export function AppendDialog({ current, others, onClose, onRun }: AppendDialogProps) {
  const [picked, setPicked] = useState<string[]>(others.map((o) => o.tabId));
  const [tag, setTag] = useState(true);
  const [column, setColumn] = useState("source");
  const toggle = (id: string, on: boolean) =>
    setPicked(
      on
        ? others.map((o) => o.tabId).filter((t) => t === id || picked.includes(t))
        : picked.filter((p) => p !== id),
    );
  const names = new Set(
    [current, ...others.filter((o) => picked.includes(o.tabId))].flatMap((t) =>
      t.columns.map((c) => c.name),
    ),
  );
  return (
    <ToolDialog
      title="Append tabs"
      runLabel="Append"
      onClose={onClose}
      blocked={
        others.length === 0
          ? "Open another file first"
          : picked.length === 0
            ? "Pick at least one more tab"
            : tag && column.trim() === ""
              ? "Name the source column"
              : undefined
      }
      onRun={() => onRun([current.tabId, ...picked], tag ? column.trim() : undefined)}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className={`mb-1 ${labelClass}`}>
          Rows of {current.title}, then of (columns matched by name)
        </legend>
        {others.length === 0 ? (
          <p className="text-fg-muted">
            Open the other files in tabs first (once their data is read).
          </p>
        ) : (
          <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
            {others.map((o) => (
              <label
                key={o.tabId}
                className="flex min-w-0 items-center gap-1.5 text-fg"
                title={o.title}
              >
                <input
                  type="checkbox"
                  checked={picked.includes(o.tabId)}
                  onChange={(e) => toggle(o.tabId, e.target.checked)}
                />
                <span className="truncate">{o.title}</span>
                <span className="ml-auto shrink-0 text-fg-subtle">{o.columns.length} columns</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-1.5 text-fg">
          <input type="checkbox" checked={tag} onChange={(e) => setTag(e.target.checked)} />
          Add a column with each row's tab name
        </label>
        {tag && (
          <input
            aria-label="Source column name"
            className={fieldClass}
            value={column}
            onChange={(e) => setColumn(e.target.value)}
          />
        )}
        <p className="text-fg-subtle">
          {names.size} columns in all; a column missing from a tab is empty for its rows.
        </p>
      </div>
    </ToolDialog>
  );
}
