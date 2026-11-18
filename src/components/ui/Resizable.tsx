import { useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { clampWidth, MIN_MAIN } from "../../stores/layout";

interface ResizableProps {
  /** Which side of the window the panel is on; the handle is on its inner edge. */
  side: "left" | "right";
  width: number;
  defaultWidth: number;
  min: number;
  /** The panel on the other side, which also needs its room (0 when hidden). */
  otherWidth: number;
  onWidth: (width: number) => void;
  /** Names the handle, e.g. "Resize the sidebar". */
  label: string;
  children: ReactNode;
}

/** Arrow keys move the edge this far (with Shift, four times as far). */
const STEP = 16;

/**
 * A side panel whose inner edge can be dragged to change its width, as in
 * code editors: double-click the edge for the default width, or use the
 * arrow keys on it. The grid between the panels always keeps room
 * (`MIN_MAIN`), also when the window gets smaller.
 */
export function Resizable({
  side,
  width,
  defaultWidth,
  min,
  otherWidth,
  onWidth,
  label,
  children,
}: ResizableProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const fit = (w: number) => clampWidth(w, min, window.innerWidth, otherWidth);
  const max = Math.max(min, window.innerWidth - otherWidth - MIN_MAIN);
  // Drag right widens a left panel and narrows a right one.
  const sign = side === "left" ? 1 : -1;

  return (
    <div
      className="relative flex shrink-0"
      style={{
        width: `min(${width}px, max(${min}px, calc(100vw - ${otherWidth + MIN_MAIN}px)))`,
      }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.min(width, max)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title={`${label} (double-click for the default width)`}
        data-dragging={dragging || undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          start.current = { x: e.clientX, width: Math.min(width, max) };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          onWidth(fit(start.current.width + sign * (e.clientX - start.current.x)));
        }}
        onPointerUp={() => {
          start.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDragging(false);
        }}
        onDoubleClick={() => onWidth(fit(defaultWidth))}
        onKeyDown={(e) => {
          const step = e.shiftKey ? STEP * 4 : STEP;
          const by = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : null;
          if (by !== null) onWidth(fit(Math.min(width, max) + sign * by));
          else if (e.key === "Home") onWidth(min);
          else if (e.key === "End") onWidth(max);
          else if (e.key === "Enter") onWidth(fit(defaultWidth));
          else return;
          e.preventDefault();
        }}
        className={cn(
          // A 7px target over the edge; the line shows on hover, drag and focus.
          "group absolute inset-y-0 z-20 flex w-[7px] cursor-col-resize justify-center outline-none",
          side === "left" ? "-right-[4px]" : "-left-[4px]",
        )}
      >
        <span
          className={cn(
            "h-full w-[2px] transition-colors duration-[var(--duration)]",
            dragging
              ? "bg-accent"
              : "bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent",
          )}
        />
      </div>
    </div>
  );
}
