import { useEffect, useRef } from "react";
import { LoaderCircle, Plus, Settings, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { fileKind, type FileKind } from "../../lib/fileKind";
import { modKey } from "../../lib/platform";
import { scrollSideways } from "../../lib/wheel";
import type { Tab } from "../../stores/tabs";
import { IconButton } from "../ui/Button";
import { FileIcon } from "./FileIcon";

interface TabBarProps {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
  /** The Settings tab, after the files' tabs while it's open. */
  settings?: { active: boolean; onSelect: () => void; onClose: () => void };
  /**
   * "row": the tabs' own row above the file, beside the sidebar (with
   * DataLiq's own title bar). "inline": inside the title bar's row.
   */
  variant?: "row" | "inline";
}

/** The Settings tab's id among the tabs. */
export const SETTINGS_TAB = "settings";

interface Item {
  id: string;
  title: string;
  path?: string;
  busy: boolean;
  kind?: FileKind;
}

/**
 * The open files' tabs. Flat tabs side by side; the one in front takes the
 * file's background and a line in the brand colour on top, so it joins the
 * file below. Many tabs scroll sideways (the wheel scrolls them too) instead
 * of pushing the window wider.
 */
export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onOpen,
  settings,
  variant = "inline",
}: TabBarProps) {
  const items: Item[] = tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    path: tab.path,
    busy: tab.status === "loading" || tab.import?.status === "running",
    kind: fileKind(tab),
  }));
  if (settings) items.push({ id: SETTINGS_TAB, title: "Settings", busy: false });
  const current = settings?.active ? SETTINGS_TAB : activeId;
  const select = (id: string) => (id === SETTINGS_TAB ? settings?.onSelect() : onSelect(id));
  const closeItem = (id: string) => (id === SETTINGS_TAB ? settings?.onClose() : onClose(id));

  // The tab in front stays in view when there are more than fit.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!current) return;
    list.current
      ?.querySelector(`[data-tab-id="${CSS.escape(current)}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <div
      className={cn(
        "flex min-w-0 items-stretch",
        variant === "row"
          ? // The line under the tabs; the tab in front covers it.
            "h-[var(--tab-height)] shrink-0 bg-surface shadow-[inset_0_-1px_0_var(--border)]"
          : "h-full flex-1",
      )}
    >
      <div
        ref={list}
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
        onWheel={scrollSideways}
        // Tabs pattern: one tab in the Tab order, arrows move between them,
        // Delete closes one.
        onKeyDown={(e) => {
          const focused = (e.target as HTMLElement)
            .closest("[data-tab-id]")
            ?.getAttribute("data-tab-id");
          const i = items.findIndex((t) => t.id === (focused ?? current));
          if (i < 0) return;
          const to =
            e.key === "ArrowRight"
              ? (i + 1) % items.length
              : e.key === "ArrowLeft"
                ? (i - 1 + items.length) % items.length
                : e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? items.length - 1
                    : null;
          if (to !== null) {
            e.preventDefault();
            select(items[to]!.id);
            // React clears currentTarget after the handler.
            const node = e.currentTarget;
            requestAnimationFrame(() =>
              node
                .querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(items[to]!.id)}"]`)
                ?.focus(),
            );
          } else if (e.key === "Delete") {
            e.preventDefault();
            closeItem(items[i]!.id);
          }
        }}
      >
        {items.map((tab) => {
          const front = tab.id === current;
          return (
            <div
              key={tab.id}
              className={cn(
                "group relative flex max-w-56 min-w-24 items-center border-r border-border text-[13px]",
                front
                  ? "bg-bg text-fg before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent"
                  : "text-fg-muted hover:bg-hover hover:text-fg",
              )}
            >
              <button
                role="tab"
                type="button"
                aria-selected={front}
                aria-keyshortcuts="Delete"
                data-tab-id={tab.id}
                tabIndex={front ? 0 : -1}
                title={tab.path}
                onClick={() => select(tab.id)}
                // Middle-click closes, as in browsers.
                onAuxClick={(e) => e.button === 1 && closeItem(tab.id)}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-3 focus-visible:outline-offset-[-2px]"
              >
                {tab.busy ? (
                  <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : tab.id === SETTINGS_TAB ? (
                  <Settings className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <FileIcon kind={tab.kind ?? "table"} />
                )}
                <span className="truncate">{tab.title}</span>
              </button>
              {/* For the mouse; from the keyboard, Delete on the tab (or Ctrl+W). */}
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                title={`Close (${modKey}+W)`}
                onClick={() => closeItem(tab.id)}
                className={cn(
                  "mr-1 flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-active hover:text-fg",
                  front ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <IconButton
        label={`Open file (${modKey}+O)`}
        onClick={onOpen}
        className="mx-1 shrink-0 self-center"
      >
        <Plus className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}
