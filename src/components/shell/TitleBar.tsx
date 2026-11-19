import type { ReactNode } from "react";
import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import icon from "../../../assets/icon-small.svg";
import { modKey } from "../../lib/platform";
import { IconButton } from "../ui/Button";
import { WindowControls } from "./WindowControls";

interface TitleBarProps {
  /**
   * DataLiq's own title bar, with no system one above it: the app's icon,
   * the menus, the search in the middle and the window buttons at the end.
   * Its empty parts move the window (and a double click maximises it).
   */
  own: boolean;
  /** Draws the window's minimise, maximise and close buttons (own title bar, in the app). */
  controls?: boolean;
  /** The menu bar (Windows and Linux). */
  menu?: ReactNode;
  /** The file tabs, when they share this row (under the system's title bar). */
  tabs?: ReactNode;
  /** The search box (the command search), in the middle of the row. */
  search?: ReactNode;
  /** Which panels are shown, and toggling them. */
  panels?: { left: boolean; right: boolean; bottom: boolean };
  onTogglePanel?: (panel: "left" | "right" | "bottom") => void;
}

const PANELS = [
  { id: "left", icon: PanelLeft, name: "sidebar", key: "Ctrl+B" },
  { id: "bottom", icon: PanelBottom, name: "SQL panel", key: "Ctrl+J" },
  { id: "right", icon: PanelRight, name: "column profile", key: "Ctrl+Alt+B" },
] as const;

/** Moves the window when pressed (Tauri's drag regions); only where nothing else is. */
const DRAG = { "data-tauri-drag-region": "" };

export function TitleBar({
  own,
  controls,
  menu,
  tabs,
  search,
  panels,
  onTogglePanel,
}: TitleBarProps) {
  const panelButtons = panels && onTogglePanel && (
    <div className="ml-1 flex shrink-0 items-center" role="group" aria-label="Panels">
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
  );

  if (!own)
    // Under the system's title bar: one row with the menus, the tabs, the search and the panels.
    return (
      <header className="flex h-[var(--chrome-height)] shrink-0 items-center gap-1 border-b border-border bg-surface pr-2 pl-2">
        {menu && (
          <>
            {menu}
            <div className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
          </>
        )}
        {tabs ?? <div className="flex-1" />}
        {search}
        {panelButtons}
      </header>
    );

  // The window's title bar. Three columns so the search sits in the middle of
  // the window: the sides share the room equally but never get narrower than
  // what's in them (the menus, the window buttons); the search gives way first.
  return (
    <header
      {...DRAG}
      className="grid h-[var(--chrome-height)] shrink-0 grid-cols-[minmax(max-content,1fr)_minmax(0,30rem)_minmax(max-content,1fr)] items-center overflow-hidden border-b border-border bg-surface"
    >
      <div {...DRAG} className="flex h-full items-center pl-1">
        <span {...DRAG} className="grid h-full w-8 shrink-0 place-items-center">
          <img src={icon} alt="" className="pointer-events-none size-4" draggable={false} />
        </span>
        {menu}
        <div {...DRAG} className="h-full min-w-4 flex-1" />
      </div>
      {search}
      <div {...DRAG} className="flex h-full items-center justify-end pl-4">
        <div {...DRAG} className="h-full flex-1" />
        {panelButtons}
        {controls ? <WindowControls /> : <div className="w-2 shrink-0" />}
      </div>
    </header>
  );
}
