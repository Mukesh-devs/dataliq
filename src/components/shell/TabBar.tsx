import { Command, Plus, Search, Table2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { modKey } from "../../lib/platform";
import type { Tab } from "../../stores/tabs";
import { IconButton } from "../ui/Button";

interface TabBarProps {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onOpen: () => void;
}

export function TabBar({ tabs, activeId, onSelect, onOpen }: TabBarProps) {
  return (
    <header className="flex h-[var(--chrome-height)] shrink-0 items-center gap-1 border-b border-border bg-surface pr-2 pl-2">
      <div role="tablist" aria-label="Open files" className="flex min-w-0 items-center gap-0.5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === activeId}
            title={tab.path}
            onClick={() => onSelect(tab.id)}
            className={cn(
              "flex h-7 max-w-52 items-center gap-1.5 truncate rounded-[var(--radius)] px-2.5 text-[13px]",
              tab.id === activeId
                ? "bg-bg text-fg shadow-[0_0_0_1px_var(--border)]"
                : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            <Table2 className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{tab.title}</span>
          </button>
        ))}
      </div>
      <IconButton label={`Open file (${modKey}+O)`} onClick={onOpen}>
        <Plus className="size-4" aria-hidden />
      </IconButton>
      <div className="flex-1" />
      <button
        type="button"
        className="flex h-7 w-56 items-center gap-2 rounded-[var(--radius)] border border-border bg-bg px-2 text-fg-subtle hover:border-border-strong"
        aria-label="Search commands"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">Search…</span>
        <span className="flex items-center gap-0.5 text-[11px]">
          {modKey === "⌘" ? <Command className="size-3" aria-hidden /> : "Ctrl+"}K
        </span>
      </button>
    </header>
  );
}
