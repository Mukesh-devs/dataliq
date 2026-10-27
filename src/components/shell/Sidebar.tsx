import { Columns3, Database, Files, Pin } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { describeColumns } from "../../lib/arrow";
import { label, reconcile, setHidden, showAll, visible, type ColumnLayout } from "../../lib/layout";
import { formatBytes } from "../../lib/format";
import { useApp } from "../../stores/app";
import type { Tab } from "../../stores/tabs";
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
  onLayoutChange?: (layout: ColumnLayout) => void;
}

export function Sidebar({ tabs, active, onLayoutChange }: SidebarProps) {
  return (
    <aside
      aria-label="Sidebar"
      className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface"
    >
      <Section title="Files" icon={<Files className="size-3.5" aria-hidden />}>
        {tabs.length === 0 ? (
          <p className="px-1.5 text-fg-subtle">No files open</p>
        ) : (
          <ul>
            {tabs.map((t) => (
              <li key={t.id} className="truncate rounded-[var(--radius)] px-1.5 py-1 text-fg-muted">
                {t.title}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Columns" icon={<Columns3 className="size-3.5" aria-hidden />}>
        {active?.preview ? (
          <ColumnList tab={active} onLayoutChange={onLayoutChange} />
        ) : (
          <p className="px-1.5 text-fg-subtle">Open a file to see its columns</p>
        )}
      </Section>
      <div className="flex-1" />
      <CacheSection />
    </aside>
  );
}

/** The active file's columns: tick to show or hide, in display order. */
function ColumnList({
  tab,
  onLayoutChange,
}: {
  tab: Tab;
  onLayoutChange?: (layout: ColumnLayout) => void;
}) {
  const columns = useMemo(() => (tab.preview ? describeColumns(tab.preview) : []), [tab.preview]);
  const layout = useMemo(
    () =>
      reconcile(
        tab.layout,
        columns.map((c) => c.name),
      ),
    [tab.layout, columns],
  );
  const hidden = new Set(layout.hidden);
  const shown = visible(layout).length;
  return (
    <div className="flex flex-col">
      <div className="flex items-center px-1.5 pb-0.5 text-[11px] text-fg-subtle">
        <span className="flex-1">
          {shown} of {layout.order.length} shown
        </span>
        {hidden.size > 0 && onLayoutChange && (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => onLayoutChange(showAll(layout))}
          >
            Show all
          </button>
        )}
      </div>
      <ul aria-label="Columns" className="flex flex-col">
        {layout.order.map((name) => (
          <li key={name}>
            <label
              className="flex items-center gap-2 rounded-[var(--radius)] px-1.5 py-0.5 text-[12px] text-fg-muted hover:bg-hover"
              title={name}
            >
              <input
                type="checkbox"
                aria-label={`Show ${label(layout, name)}`}
                checked={!hidden.has(name)}
                disabled={!onLayoutChange || (!hidden.has(name) && shown === 1)}
                onChange={(e) => onLayoutChange?.(setHidden(layout, name, !e.target.checked))}
              />
              <span
                className={hidden.has(name) ? "flex-1 truncate text-fg-subtle" : "flex-1 truncate"}
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
