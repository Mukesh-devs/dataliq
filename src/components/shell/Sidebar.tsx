import {
  Binary,
  Box,
  Braces,
  Calendar,
  Clock,
  Columns3,
  Database,
  Files,
  Hash,
  Pin,
  Search,
  ToggleLeft,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeColumns, type ColumnKind } from "../../lib/arrow";
import {
  invertHidden,
  label,
  matchColumns,
  reconcile,
  setHidden,
  setManyHidden,
  showOnly,
  visible,
  type ColumnLayout,
} from "../../lib/layout";
import { formatBytes } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useApp } from "../../stores/app";
import { baseOf, type Tab } from "../../stores/tabs";
import { Button } from "../ui/Button";

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1 px-2 py-2">
      <h2 className="flex items-center gap-1.5 px-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

interface SidebarProps {
  tabs: Tab[];
  /** The active tab, whose columns are listed. */
  active?: Tab;
  /** Switches to a file's tab. */
  onSelect?: (id: string) => void;
  onLayoutChange?: (layout: ColumnLayout) => void;
}

export function Sidebar({ tabs, active, onSelect, onLayoutChange }: SidebarProps) {
  return (
    <aside
      aria-label="Sidebar"
      className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface"
    >
      <Section title="Files" icon={<Files className="size-3.5" aria-hidden />}>
        {tabs.length === 0 ? (
          <p className="px-1.5 text-fg-subtle">No files open</p>
        ) : (
          <ul aria-label="Files">
            {tabs.map((t) => {
              const current = t.id === active?.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    title={t.path ?? t.title}
                    aria-current={current ? "true" : undefined}
                    disabled={!onSelect}
                    onClick={() => onSelect?.(t.id)}
                    className={cn(
                      "flex min-h-6 w-full items-center truncate rounded-[var(--radius)] px-1.5 text-left",
                      current ? "bg-hover font-medium text-fg" : "text-fg-muted hover:bg-hover",
                    )}
                  >
                    <span className="truncate">{t.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title="Columns" icon={<Columns3 className="size-3.5" aria-hidden />}>
        {active?.preview ? (
          <ColumnList key={active.id} tab={active} onLayoutChange={onLayoutChange} />
        ) : (
          <p className="px-1.5 text-fg-subtle">Open a file to see its columns</p>
        )}
      </Section>
      <div className="flex-1" />
      <CacheSection />
    </aside>
  );
}

/** Show the search box from this many columns. */
const SEARCH_FROM = 8;

const KIND_ICON: Record<ColumnKind, { icon: LucideIcon; name: string }> = {
  integer: { icon: Hash, name: "Whole number" },
  number: { icon: Hash, name: "Number" },
  text: { icon: Type, name: "Text" },
  boolean: { icon: ToggleLeft, name: "True / false" },
  date: { icon: Calendar, name: "Date" },
  timestamp: { icon: Calendar, name: "Date and time" },
  time: { icon: Clock, name: "Time" },
  json: { icon: Braces, name: "JSON" },
  binary: { icon: Binary, name: "Binary" },
  other: { icon: Box, name: "Other" },
};

function KindIcon({ kind }: { kind: ColumnKind | undefined }) {
  const { icon: Icon, name } = KIND_ICON[kind ?? "other"];
  return (
    <span title={name} className="flex shrink-0 text-fg-subtle">
      <Icon className="size-3" aria-hidden />
    </span>
  );
}

/** A checkbox that can show "some" (indeterminate). */
function TriStateCheckbox({
  checked,
  mixed,
  ...props
}: {
  checked: boolean;
  mixed: boolean;
  disabled?: boolean;
  onChange: () => void;
  "aria-label": string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-checked={mixed ? "mixed" : checked}
      {...props}
    />
  );
}

const linkButton =
  "rounded-[var(--radius)] px-1 text-accent hover:underline disabled:text-fg-subtle disabled:no-underline";

/**
 * The active file's columns: tick to show or hide, in display order. A box
 * on top shows or hides all of them (or all that match the search).
 */
function ColumnList({
  tab,
  onLayoutChange,
}: {
  tab: Tab;
  onLayoutChange?: (layout: ColumnLayout) => void;
}) {
  const preview = baseOf(tab).preview;
  const columns = useMemo(() => (preview ? describeColumns(preview) : []), [preview]);
  const kinds = useMemo(() => new Map(columns.map((c) => [c.name, c.kind])), [columns]);
  const layout = useMemo(
    () =>
      reconcile(
        tab.layout,
        columns.map((c) => c.name),
      ),
    [tab.layout, columns],
  );
  const [query, setQuery] = useState("");
  const hidden = new Set(layout.hidden);
  const shown = visible(layout).length;
  const matching = matchColumns(layout, query);
  const searching = query.trim() !== "";
  const shownMatching = matching.filter((c) => !hidden.has(c)).length;
  const allShown = matching.length > 0 && shownMatching === matching.length;
  const mixed = shownMatching > 0 && !allShown;
  const filtered = [
    ...new Set((tab.view?.filters ?? []).map((f) => f.column).filter((c) => kinds.has(c))),
  ];
  const change = onLayoutChange;
  return (
    <div className="flex flex-col gap-1">
      {(layout.order.length >= SEARCH_FROM || searching) && (
        <div className="relative mx-1.5">
          <Search
            className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Find columns"
            placeholder="Find columns"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && query !== "" && setQuery("")}
            className="h-6 w-full rounded-[var(--radius)] border border-border bg-bg pr-6 pl-5 text-[12px] text-fg placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:hidden"
          />
          {query !== "" && (
            <button
              type="button"
              aria-label="Clear column search"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-0.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius)] text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </div>
      )}
      <div className="flex min-h-6 items-center gap-2 px-1.5 text-[11px] text-fg-subtle">
        <TriStateCheckbox
          aria-label={searching ? "Show all matching columns" : "Show all columns"}
          checked={allShown}
          mixed={mixed}
          disabled={!change || matching.length === 0}
          onChange={() => change?.(setManyHidden(layout, allShown, matching))}
        />
        <span className="flex-1 truncate">
          {searching
            ? `${shownMatching} of ${matching.length} matching`
            : `${shown} of ${layout.order.length} shown`}
        </span>
        <button
          type="button"
          className={linkButton}
          title={searching ? "Show the hidden matching columns, hide the shown ones" : undefined}
          disabled={!change || matching.length === 0}
          onClick={() => change?.(invertHidden(layout, matching))}
        >
          Invert
        </button>
        {filtered.length > 0 && (
          <button
            type="button"
            className={linkButton}
            title="Show only the columns with a filter"
            disabled={!change}
            onClick={() => change?.(showOnly(layout, filtered))}
          >
            Filtered
          </button>
        )}
      </div>
      {matching.length === 0 ? (
        <p className="px-1.5 text-[12px] text-fg-subtle">No columns match “{query.trim()}”</p>
      ) : (
        <ul aria-label="Columns" className="flex flex-col">
          {matching.map((name) => (
            <li key={name}>
              <label
                // At least 24px tall: each checkbox gets a 24px target (WCAG 2.5.8).
                className="flex min-h-6 items-center gap-2 rounded-[var(--radius)] px-1.5 text-[12px] text-fg-muted hover:bg-hover"
                title={name}
              >
                <input
                  type="checkbox"
                  aria-label={`Show ${label(layout, name)}`}
                  checked={!hidden.has(name)}
                  disabled={!change || (!hidden.has(name) && shown === 1)}
                  onChange={(e) => change?.(setHidden(layout, name, !e.target.checked))}
                />
                <KindIcon kind={kinds.get(name)} />
                <span
                  className={
                    hidden.has(name) ? "flex-1 truncate text-fg-subtle" : "flex-1 truncate"
                  }
                >
                  {label(layout, name)}
                </span>
                {layout.pinned.includes(name) && (
                  <Pin className="size-3 text-fg-subtle" aria-label="Pinned" />
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CacheSection() {
  const cache = useApp((s) => s.cache);
  const clear = useApp((s) => s.clearCache);
  if (!cache) return null;
  return (
    <Section title="Cache" icon={<Database className="size-3.5" aria-hidden />}>
      <div className="flex items-center gap-2 px-1.5 text-[12px] text-fg-muted">
        <span className="tabular flex-1 truncate whitespace-nowrap" title={cache.dir}>
          {cache.enabled
            ? `${formatBytes(cache.usedBytes)} of ${formatBytes(cache.maxBytes)}`
            : "Caching is off"}
        </span>
        {cache.enabled && cache.entries > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void clear()}>
            Clear cache
          </Button>
        )}
      </div>
    </Section>
  );
}
