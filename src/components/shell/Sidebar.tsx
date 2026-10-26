import { Columns3, Database, Files } from "lucide-react";
import type { ReactNode } from "react";
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

export function Sidebar({ tabs }: { tabs: Tab[] }) {
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
        <p className="px-1.5 text-fg-subtle">Open a file to see its columns</p>
      </Section>
      <div className="flex-1" />
      <CacheSection />
    </aside>
  );
}

function CacheSection() {
  const cache = useApp((s) => s.cache);
  const clear = useApp((s) => s.clearCache);
  if (!cache) return null;
  return (
    <Section title="Cache" icon={<Database className="size-3.5" aria-hidden />}>
      <div className="flex items-center gap-2 px-1.5 text-[12px] text-fg-muted">
        <span className="tabular flex-1" title={cache.dir}>
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
