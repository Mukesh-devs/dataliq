import * as Popover from "@radix-ui/react-popover";
import { useEffect, useId, useMemo, useState } from "react";
import type { ColumnInfo } from "../../lib/arrow";
import { formatCount } from "../../lib/format";
import { filterFamily, type Filter, type ValueList } from "../../lib/view";
import { Button } from "../ui/Button";
import { canNegate, emptyDraft, fromFilter, opLabel, OPS, toFilter, type Draft } from "./draft";

/** Something Radix can position the popover against (an element or a rectangle). */
export interface Anchor {
  getBoundingClientRect(): DOMRect;
}

interface FilterEditorProps {
  column: ColumnInfo;
  /** The filter being edited; a new one is created when absent. */
  filter?: Filter;
  anchor: Anchor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (filter: Filter) => void;
  onRemove?: () => void;
  /** Loads the column's values for "is one of"; absent until the data is ready. */
  loadValues?: (search: string) => Promise<ValueList>;
}

const inputClass =
  "h-7 w-full min-w-0 rounded-[var(--radius)] border border-border bg-bg px-2 text-fg outline-none focus:border-accent";

/**
 * Popover for one column filter, with conditions that fit the column's type.
 * The inputs start from `filter` when the editor mounts; mount a fresh editor
 * (e.g. with a `key`) for each filter edited.
 */
export function FilterEditor(props: FilterEditorProps) {
  const { column, filter, anchor, open, onOpenChange, onApply, onRemove, loadValues } = props;
  const family = filterFamily(column.kind);
  const [draft, setDraft] = useState<Draft>(() =>
    filter ? fromFilter(filter, family) : emptyDraft(family),
  );
  const [error, setError] = useState<string | null>(null);
  // Radix positions the popover against `virtualRef.current`.
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const id = useId();

  const update = (changes: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...changes }));
    setError(null);
  };
  const valueType = column.kind === "date" ? "date" : "text";
  const placeholder =
    family === "number"
      ? "Number"
      : column.kind === "timestamp"
        ? "YYYY-MM-DD hh:mm"
        : column.kind === "time"
          ? "hh:mm:ss"
          : family === "date"
            ? "YYYY-MM-DD"
            : "Text";
  const needsValue = [
    "contains",
    "equals",
    "startsWith",
    "endsWith",
    "regex",
    "gt",
    "gte",
    "lt",
    "lte",
  ];

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<Anchor>} />
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={`Filter ${column.name}`}
          className="z-50 w-80 rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              const result = toFilter(column.name, family, draft);
              if ("error" in result) {
                setError(result.error);
                return;
              }
              onApply(result.filter);
              onOpenChange(false);
            }}
          >
            <h2 className="truncate font-semibold text-fg" title={column.name}>
              Filter {column.name}
            </h2>
            <select
              aria-label="Condition"
              className={inputClass}
              value={draft.op}
              onChange={(e) => update({ op: e.target.value as Draft["op"] })}
            >
              {OPS[family].map((op) => (
                <option key={op} value={op} disabled={op === "in" && !loadValues}>
                  {opLabel(op, family)}
                </option>
              ))}
            </select>

            {needsValue.includes(draft.op) && (
              <input
                aria-label="Value"
                autoFocus
                className={inputClass}
                type={draft.op === "regex" ? "text" : valueType}
                inputMode={family === "number" ? "decimal" : undefined}
                placeholder={draft.op === "regex" ? "Regular expression" : placeholder}
                value={draft.value}
                onChange={(e) => update({ value: e.target.value })}
              />
            )}
            {draft.op === "range" && (
              <div className="flex items-center gap-2">
                <input
                  aria-label="From"
                  autoFocus
                  className={inputClass}
                  type={valueType}
                  placeholder={`From (${placeholder.toLowerCase()})`}
                  value={draft.value}
                  onChange={(e) => update({ value: e.target.value })}
                />
                <span className="text-fg-subtle">–</span>
                <input
                  aria-label="To"
                  className={inputClass}
                  type={valueType}
                  placeholder="To"
                  value={draft.value2}
                  onChange={(e) => update({ value2: e.target.value })}
                />
              </div>
            )}
            {draft.op === "lastDays" && (
              <label className="flex items-center gap-2 text-fg-muted">
                <input
                  aria-label="Days"
                  autoFocus
                  className={`${inputClass} w-24`}
                  type="number"
                  min={0}
                  value={draft.days}
                  onChange={(e) => update({ days: e.target.value })}
                />
                days, up to today
              </label>
            )}
            {draft.op === "in" && loadValues && (
              <ValuePicker
                load={loadValues}
                selected={draft.selected}
                onChange={(selected) => update({ selected })}
              />
            )}
            {["contains", "startsWith", "endsWith"].includes(draft.op) && (
              <label className="flex items-center gap-2 text-fg-muted">
                <input
                  type="checkbox"
                  checked={draft.caseSensitive}
                  onChange={(e) => update({ caseSensitive: e.target.checked })}
                />
                Match case
              </label>
            )}
            {canNegate(draft.op) && (
              <label className="flex items-center gap-2 text-fg-muted">
                <input
                  id={`${id}-not`}
                  type="checkbox"
                  checked={draft.not}
                  onChange={(e) => update({ not: e.target.checked })}
                />
                Exclude matching rows
              </label>
            )}
            {error && (
              <p role="alert" className="text-[12px] text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              {onRemove && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    onRemove();
                    onOpenChange(false);
                  }}
                >
                  Remove
                </Button>
              )}
              <Button type="submit" variant="primary">
                Apply
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface ValuePickerProps {
  load: (search: string) => Promise<ValueList>;
  selected: (string | null)[];
  onChange: (selected: (string | null)[]) => void;
}

/** Searchable list of a column's values with row counts. */
function ValuePicker({ load, selected, onChange }: ValuePickerProps) {
  const [search, setSearch] = useState("");
  const [list, setList] = useState<ValueList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () => {
        load(search)
          .then((l) => alive && (setList(l), setError(null)))
          .catch((e: unknown) => {
            if (alive && (e as { kind?: string }).kind !== "cancelled")
              setError(e instanceof Error ? e.message : String(e));
          });
      },
      search ? 200 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [load, search]);

  const picked = useMemo(() => new Set(selected), [selected]);
  const toggle = (v: string | null) =>
    onChange(picked.has(v) ? selected.filter((s) => s !== v) : [...selected, v]);

  return (
    <div className="flex flex-col gap-1.5">
      <input
        aria-label="Search values"
        autoFocus
        className={inputClass}
        placeholder="Search values"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul
        aria-label="Values"
        className="max-h-56 overflow-y-auto rounded-[var(--radius)] border border-border py-1"
      >
        {!list && !error && <li className="px-2 py-1 text-fg-subtle">Loading values…</li>}
        {error && <li className="px-2 py-1 text-danger">{error}</li>}
        {list?.values.length === 0 && <li className="px-2 py-1 text-fg-subtle">No values</li>}
        {list?.values.map((v) => (
          <li key={v.value ?? "\u0000null"}>
            <label className="flex items-center gap-2 px-2 py-0.5 hover:bg-hover">
              <input
                type="checkbox"
                checked={picked.has(v.value)}
                onChange={() => toggle(v.value)}
              />
              <span
                className={
                  v.value === null ? "flex-1 truncate italic text-fg-subtle" : "flex-1 truncate"
                }
              >
                {v.value === null ? "null" : v.value === "" ? "(empty)" : v.value}
              </span>
              <span className="tabular text-[12px] text-fg-subtle">{formatCount(v.count)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between text-[12px] text-fg-subtle">
        <span>
          {selected.length} selected
          {list?.truncated && " · showing the most common values"}
        </span>
        {selected.length > 0 && (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => onChange([])}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
