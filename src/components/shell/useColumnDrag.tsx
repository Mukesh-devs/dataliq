import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useSql } from "../../stores/sql";

/** How far the pointer moves before a press becomes a drag. */
const DRAG_FROM = 5;

interface Ghost {
  text: string;
  x: number;
  y: number;
  /** Over the SQL editor, where it would drop. */
  over: boolean;
}

/**
 * Dragging a column's name into the SQL editor. Pointer events, not the
 * browser's drag and drop: on Windows, Tauri's file drop (dropping files on
 * the window) turns that off inside the page.
 *
 * `start` goes on a row's pointerdown; `clickAfterDrag` tells the row's
 * click that it ended a drag (so it doesn't tick the checkbox); `ghost` is
 * the name following the pointer.
 */
export function useColumnDrag() {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const dragged = useRef(false);

  const start = (e: ReactPointerEvent, text: string) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    // The checkbox keeps its own click.
    if ((e.target as Element).closest("input")) return;
    const from = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const editor = () => useSql.getState().editor;

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_FROM) return;
        dragging = true;
        document.body.style.cursor = "grabbing";
        // The editor is where it goes: show it.
        if (!useSql.getState().open) useSql.getState().setOpen(true);
      }
      ev.preventDefault();
      const over = editor()?.showDropAt(ev.clientX, ev.clientY) ?? false;
      setGhost({ text, x: ev.clientX, y: ev.clientY, over });
    };
    const finish = (drop: PointerEvent | null) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      if (!dragging) return;
      document.body.style.cursor = "";
      if (drop) editor()?.dropAt(text, drop.clientX, drop.clientY);
      editor()?.endDrop();
      setGhost(null);
      // The click that may follow the release belongs to the drag.
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
    };
    const up = (ev: PointerEvent) => finish(ev);
    const cancel = () => finish(null);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  const clickAfterDrag = () => dragged.current;

  const ghostEl =
    ghost &&
    createPortal(
      <div
        role="presentation"
        data-testid="column-drag"
        className={cn(
          "pointer-events-none fixed z-[1000] flex items-center gap-2 rounded-[var(--radius)] border px-2 py-1 text-[12px] shadow-[0_6px_16px_rgb(0_0_0/0.16)]",
          ghost.over ? "border-accent bg-accent text-accent-fg" : "border-border bg-bg text-fg",
        )}
        style={{ left: ghost.x + 14, top: ghost.y + 10 }}
      >
        <span className="font-mono">{ghost.text}</span>
        {!ghost.over && <span className="text-fg-subtle">Drop in the SQL editor</span>}
      </div>,
      document.body,
    );

  return { start, clickAfterDrag, ghost: ghostEl };
}
