import type { ReactNode } from "react";
import {
  Command,
  LoaderCircle,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Table2,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { modKey } from "../../lib/platform";
import type { Tab } from "../../stores/tabs";
import { IconButton } from "../ui/Button";

interface TabBarProps {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
  onCommands?: () => void;
  /** Which panels are shown, and toggling them (top right of the window). */
  panels?: { left: boolean; right: boolean; bottom: boolean };
  onTogglePanel?: (panel: "left" | "right" | "bottom") => void;
  /** The menu bar, first in the row (Windows and Linux). */
  menu?: ReactNode;
}

const PANELS = [
  { id: "left", icon: PanelLeft, name: "sidebar", key: "Ctrl+B" },
  { id: "bottom", icon: PanelBottom, name: "SQL panel", key: "Ctrl+J" },
  { id: "right", icon: PanelRight, name: "column profile", key: "Ctrl+Alt+B" },
] as const;

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onOpen,
  onCommands,
  panels,
  onTogglePanel,
  menu,
}: TabBarProps) {
  return (
    <header className="flex h-[var(--chrome-height)] shrink-0 items-center gap-1 border-b border-border bg-surface pr-2 pl-2">
      {menu && (
        <>
          {menu}
          <div className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
        </>
      )}
      <div
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 items-center gap-0.5"
        // Tabs pattern: one tab in the Tab order, arrows move between them,
        // Delete closes one.
        onKeyDown={(e) => {
          const focused = (e.target as HTMLElement)
            .closest("[data-tab-id]")
            ?.getAttribute("data-tab-id");
          const i = tabs.findIndex((t) => t.id === (focused ?? activeId));
          if (i < 0) return;
          const to =
            e.key === "ArrowRight"
              ? (i + 1) % tabs.length
              : e.key === "ArrowLeft"
                ? (i - 1 + tabs.length) % tabs.length
                : e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? tabs.length - 1
                    : null;
          if (to !== null) {
            e.preventDefault();
            onSelect(tabs[to]!.id);
            // React clears currentTarget after the handler.
            const list = e.currentTarget;
            requestAnimationFrame(() =>
              list
                .querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabs[to]!.id)}"]`)
                ?.focus(),
            );
          } else if (e.key === "Delete") {
            e.preventDefault();
            onClose(tabs[i]!.id);
          }
        }}
      >
        {tabs.map((tab) => {
          const busy = tab.status === "loading" || tab.import?.status === "running";
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-7 max-w-56 items-center rounded-[var(--radius)] text-[13px]",
                tab.id === activeId
                  ? "bg-bg text-fg shadow-[0_0_0_1px_var(--border)]"
                  : "text-fg-muted hover:bg-hover hover:text-fg",
              )}
            >
              <button
                role="tab"
                type="button"
                aria-selected={tab.id === activeId}
                aria-keyshortcuts="Delete"
                data-tab-id={tab.id}
                tabIndex={tab.id === activeId ? 0 : -1}
                title={tab.path}
                onClick={() => onSelect(tab.id)}
                // Middle-click closes, as in browsers.
                onAuxClick={(e) => e.button === 1 && onClose(tab.id)}
                className="flex h-full min-w-0 items-center gap-1.5 pr-1 pl-2.5"
              >
                {busy ? (
                  <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <Table2 className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="truncate">{tab.title}</span>
              </button>
              {/* For the mouse; from the keyboard, Delete on the tab (or Ctrl+W). */}
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                title={`Close (${modKey}+W)`}
                onClick={() => onClose(tab.id)}
                className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle opacity-80 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-active hover:text-fg"
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <IconButton label={`Open file (${modKey}+O)`} onClick={onOpen}>
        <Plus className="size-4" aria-hidden />
      </IconButton>
      <div className="flex-1" />
      <button
        type="button"
        className="flex h-7 w-56 items-center gap-2 rounded-[var(--radius)] border border-border bg-bg px-2 text-fg-subtle hover:border-border-strong"
        aria-label="Search commands"
        title={`Command palette (${modKey}+K)`}
        onClick={onCommands}
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">Search…</span>
        <span className="flex items-center gap-0.5 text-[11px]">
          {modKey === "⌘" ? <Command className="size-3" aria-hidden /> : "Ctrl+"}K
        </span>
      </button>
      {panels && onTogglePanel && (
        <div className="ml-1 flex items-center" role="group" aria-label="Panels">
          {PANELS.map(({ id, icon: Icon, name, key }) => {
            const on = panels[id];
            return (
              <IconButton
                key={id}
                label={`${on ? "Hide" : "Show"} ${name} (${key.replace("Ctrl", modKey)})`}
                aria-pressed={on}
                onClick={() => onTogglePanel(id)}
                className={on ? "text-fg" : "text-fg-subtle"}
              >
                <Icon className="size-4" aria-hidden />
              </IconButton>
            );
          })}
        </div>
      )}
    </header>
  );
}
