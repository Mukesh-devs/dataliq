import * as Popover from "@radix-ui/react-popover";
import { Bookmark, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ViewSpec } from "../../lib/view";
import { missingColumns, usePresets } from "../../stores/presets";
import { Button, IconButton } from "../ui/Button";

interface FilterPresetsProps {
  view: ViewSpec;
  /** The tab's columns (real names). */
  columns: string[];
  /** Applies a preset's filters, search and sort. */
  onApply: (view: ViewSpec) => void;
}

/** "Presets": save the filters, search and sort by name; apply them to any file with those columns. */
export function FilterPresets({ view, columns, onApply }: FilterPresetsProps) {
  const presets = usePresets((s) => s.presets);
  const save = usePresets((s) => s.save);
  const remove = usePresets((s) => s.remove);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const filters = view.filters ?? [];
  const canSave = filters.length > 0 || !!view.search || (view.sort?.length ?? 0) > 0;
  const exists = presets.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" title="Saved filters" aria-label="Filter presets">
          <Bookmark className="size-3.5" aria-hidden />
          {presets.length > 0 && <span className="text-fg-subtle">{presets.length}</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label="Filter presets"
          className="z-50 flex w-80 flex-col gap-2 rounded-[var(--radius-lg)] border border-border bg-bg p-2 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          {presets.length === 0 ? (
            <p className="px-1 text-fg-muted">
              No saved filters yet. Filter the rows, then save them here to use again on this or
              another file with the same columns.
            </p>
          ) : (
            <ul aria-label="Saved filters" className="flex max-h-60 flex-col overflow-y-auto">
              {presets.map((p) => {
                const missing = missingColumns(p, columns);
                const parts = [
                  `${p.filters.length} filter${p.filters.length === 1 ? "" : "s"}`,
                  ...(p.search ? [`search “${p.search}”`] : []),
                  ...(p.sort?.length ? ["sort"] : []),
                ];
                return (
                  <li key={p.name} className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={missing.length > 0}
                      title={
                        missing.length > 0
                          ? `This file has no column ${missing.map((m) => `“${m}”`).join(", ")}`
                          : `Apply: ${parts.join(", ")}`
                      }
                      onClick={() => {
                        onApply({
                          ...view,
                          filters: p.filters,
                          search: p.search,
                          sort: p.sort ?? [],
                        });
                        setOpen(false);
                      }}
                      className="flex min-w-0 flex-1 flex-col rounded-[var(--radius)] px-1.5 py-1 text-left hover:bg-hover disabled:opacity-60 disabled:hover:bg-transparent"
                    >
                      <span className="truncate font-medium text-fg">{p.name}</span>
                      <span className="truncate text-fg-subtle">
                        {missing.length > 0 ? `Needs ${missing.join(", ")}` : parts.join(" · ")}
                      </span>
                    </button>
                    <IconButton
                      label={`Delete preset ${p.name}`}
                      className="size-6 shrink-0"
                      onClick={() => remove(p.name)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          )}
          <form
            className="flex items-center gap-1 border-t border-border pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSave || !name.trim()) return;
              save({ name, filters, search: view.search, sort: view.sort });
              setName("");
            }}
          >
            <input
              aria-label="Preset name"
              placeholder={canSave ? "Name for the current filters" : "Filter first, then save"}
              disabled={!canSave}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-fg outline-none focus:border-accent disabled:opacity-60"
            />
            <Button type="submit" size="sm" variant="primary" disabled={!canSave || !name.trim()}>
              {exists ? "Replace" : "Save"}
            </Button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
