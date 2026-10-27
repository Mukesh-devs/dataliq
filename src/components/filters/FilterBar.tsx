import * as Popover from "@radix-ui/react-popover";
import { ListFilter, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ColumnInfo } from "../../lib/arrow";
import { describeFilter, type Filter } from "../../lib/view";
import { Button } from "../ui/Button";

interface FilterBarProps {
  filters: Filter[];
  columns: ColumnInfo[];
  /** Edit filter `index`; the chip is the anchor for the editor. */
  onEdit: (index: number, anchor: HTMLElement) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  /** Start a new filter on `column`, anchored at the "Filter" button. */
  onAdd: (column: ColumnInfo, anchor: HTMLElement) => void;
}

/** Toolbar with one removable chip per filter and a button to add one. */
export function FilterBar({ filters, columns, onEdit, onRemove, onClear, onAdd }: FilterBarProps) {
  const kinds = useMemo(() => new Map(columns.map((c) => [c.name, c.kind])), [columns]);
  return (
    <div
      role="toolbar"
      aria-label="Filters"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1"
    >
      <AddFilter columns={columns} onPick={onAdd} />
      {filters.map((f, i) => {
        const label = describeFilter(f, kinds.get(f.column));
        return (
          <span
            key={`${i}:${label}`}
            className="inline-flex h-6 max-w-80 items-center rounded-full border border-border bg-surface-2 text-[12px] text-fg"
          >
            <button
              type="button"
              className="truncate rounded-l-full pr-1 pl-2.5 hover:text-accent"
              title={`Edit filter: ${label}`}
              aria-label={`Edit filter: ${label}`}
              onClick={(e) => onEdit(i, e.currentTarget)}
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={`Remove filter: ${label}`}
              title="Remove filter"
              className="mr-1 inline-flex size-4 items-center justify-center rounded-full text-fg-muted hover:bg-hover hover:text-fg"
              onClick={() => onRemove(i)}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        );
      })}
      {filters.length > 1 && (
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/** "Filter" button with a searchable column list. */
function AddFilter({
  columns,
  onPick,
}: {
  columns: ColumnInfo[];
  onPick: (column: ColumnInfo, anchor: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const shown = columns.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setSearch("");
      }}
    >
      <Popover.Trigger asChild>
        <Button ref={setTrigger} size="sm" variant="ghost" aria-label="Add filter">
          <ListFilter className="size-3.5" aria-hidden /> Filter
          <Plus className="size-3" aria-hidden />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          aria-label="Choose a column to filter"
          // The filter editor opens next and takes focus; returning focus to
          // this button would count as "outside" and close the editor.
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-50 w-64 rounded-[var(--radius-lg)] border border-border bg-bg p-2 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <input
            aria-label="Search columns"
            autoFocus
            className="mb-1.5 h-7 w-full rounded-[var(--radius)] border border-border bg-bg px-2 text-fg outline-none focus:border-accent"
            placeholder="Search columns"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0] && trigger) {
                e.preventDefault();
                setOpen(false);
                onPick(shown[0], trigger);
              }
            }}
          />
          <ul aria-label="Columns" className="max-h-64 overflow-y-auto">
            {shown.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  className="w-full truncate rounded-[var(--radius)] px-2 py-1 text-left hover:bg-hover"
                  onClick={() => {
                    setOpen(false);
                    if (trigger) onPick(c, trigger);
                  }}
                >
                  {c.name}
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-2 py-1 text-fg-subtle">No matching columns</li>
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
