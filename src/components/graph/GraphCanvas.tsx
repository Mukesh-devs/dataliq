import { ChevronDown, ChevronRight } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  LINE_HEIGHT,
  PAD_X,
  PAD_Y,
  type GraphLayout,
  type Line,
  type LineKind,
} from "../../lib/jsonGraph";
import { cn } from "../../lib/cn";

export interface GraphCanvasHandle {
  /** Zooms and pans so the whole graph shows. */
  fit(): void;
  /** Pans so a card is in the middle (keeps the zoom). */
  centre(id: string): void;
  zoomBy(factor: number): void;
}

interface GraphCanvasProps {
  layout: GraphLayout;
  /** The selected card or line (by JSON path). */
  selected: string | null;
  /** Cards that match the search. */
  matches: ReadonlySet<string>;
  onSelect: (id: string, line?: Line) => void;
  onToggle: (id: string) => void;
  /** A "more" card was picked: show more of that array. */
  onMore: (arrayId: string) => void;
  label: string;
}

const VALUE_CLASS: Record<LineKind, string> = {
  string: "text-syntax-string",
  number: "text-syntax-number",
  boolean: "text-syntax-keyword",
  null: "text-syntax-keyword",
  type: "text-fg-muted",
  empty: "text-fg-subtle",
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;

/**
 * The graph on a canvas you can pan (drag, scroll, arrow keys) and zoom
 * (Ctrl/⌘ + scroll, + and −). Cards are real elements: their titles, lines
 * and toggles are buttons, so the keyboard reaches everything.
 */
export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { layout, selected, matches, onSelect, onToggle, onMore, label },
  ref,
) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 16, y: 16, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const { clientWidth: w, clientHeight: h } = el;
    const k = Math.min(
      1,
      Math.max(MIN_ZOOM, Math.min((w - 32) / layout.width, (h - 32) / layout.height)),
    );
    setView({ k, x: (w - layout.width * k) / 2, y: Math.max(16, (h - layout.height * k) / 2) });
  }, [layout.width, layout.height]);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      centre(id) {
        const el = box.current;
        const n = layout.nodes.find((p) => p.node.id === id);
        if (!el || !n) return;
        setView((v) => ({
          ...v,
          x: el.clientWidth / 2 - (n.x + n.w / 2) * v.k,
          y: el.clientHeight / 2 - (n.y + n.h / 2) * v.k,
        }));
      },
      zoomBy(factor) {
        const el = box.current;
        if (!el) return;
        zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
      },
    }),
    [fit, layout],
  );

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });

  // Wheel: pan, or zoom with Ctrl/⌘ (and trackpad pinch). Not passive, to keep the page still.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const down = (e: ReactPointerEvent) => {
    // Cards handle their own clicks; drag the background.
    if ((e.target as HTMLElement).closest("[data-card]")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };

  return (
    <div
      ref={box}
      role="group"
      aria-label={label}
      tabIndex={0}
      data-testid="json-graph"
      className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-surface outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] active:cursor-grabbing"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const step = 60;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [step, 0],
          ArrowRight: [-step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        };
        const m = moves[e.key];
        if (m) {
          e.preventDefault();
          setView((v) => ({ ...v, x: v.x + m[0], y: v.y + m[1] }));
        } else if (e.key === "+" || e.key === "=")
          zoomAt(1.2, box.current!.clientWidth / 2, box.current!.clientHeight / 2);
        else if (e.key === "-")
          zoomAt(1 / 1.2, box.current!.clientWidth / 2, box.current!.clientHeight / 2);
        else if (e.key === "0") fit();
      }}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
        }}
      >
        <svg
          aria-hidden
          className="absolute inset-0 overflow-visible"
          width={layout.width}
          height={layout.height}
        >
          {layout.edges.map((e) => (
            <path
              key={`${e.from}>${e.to}`}
              d={e.d}
              fill="none"
              className="stroke-border-strong"
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {layout.nodes.map((p) => {
          const n = p.node;
          const isSelected = selected === n.id;
          if (n.kind === "more") {
            return (
              <button
                key={n.id}
                type="button"
                data-card
                onClick={() => n.arrayId && onMore(n.arrayId)}
                className="absolute flex flex-col justify-center rounded-[6px] border border-dashed border-accent bg-bg px-[10px] text-left font-mono text-[11px] text-accent hover:bg-accent-soft"
                style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
              >
                <span className="font-semibold">{n.title}</span>
                <span>Show more</span>
              </button>
            );
          }
          return (
            <div
              key={n.id}
              data-card
              data-id={n.id}
              className={cn(
                "absolute overflow-hidden rounded-[6px] border bg-bg font-mono text-[11px] shadow-[0_1px_2px_rgb(0_0_0/0.06)]",
                isSelected
                  ? "border-accent ring-2 ring-accent-soft"
                  : matches.has(n.id)
                    ? "border-warning"
                    : "border-border",
              )}
              style={{
                left: p.x,
                top: p.y,
                width: p.w,
                height: p.h,
                padding: `${PAD_Y}px ${PAD_X}px`,
                lineHeight: `${LINE_HEIGHT}px`,
              }}
            >
              <div className="flex items-center gap-1">
                {n.children.length > 0 && (
                  <button
                    type="button"
                    aria-label={`${p.collapsed ? "Expand" : "Collapse"} ${n.title}`}
                    aria-expanded={!p.collapsed}
                    onClick={() => onToggle(n.id)}
                    className="-ml-1 flex size-4 shrink-0 items-center justify-center rounded-[3px] text-fg-muted hover:bg-hover hover:text-fg"
                  >
                    {p.collapsed ? (
                      <ChevronRight className="size-3" aria-hidden />
                    ) : (
                      <ChevronDown className="size-3" aria-hidden />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className="min-w-0 truncate text-left font-semibold whitespace-pre text-fg hover:underline"
                  title={n.subtitle ? `${n.id} · ${n.subtitle}` : n.id}
                >
                  {n.title}
                  {n.subtitle && (
                    <span className="font-normal text-fg-subtle">{`  ${n.subtitle}`}</span>
                  )}
                </button>
              </div>
              {p.lines.map((l) => (
                <button
                  key={l.path}
                  type="button"
                  onClick={() => onSelect(l.path, l)}
                  className={cn(
                    "block w-full truncate text-left whitespace-pre hover:bg-hover",
                    selected === l.path && "bg-accent-soft",
                  )}
                  title={`${l.path}: ${l.text}`}
                >
                  <span className="text-syntax-name">{l.key}</span>
                  <span className="text-fg-subtle">: </span>
                  <span className={VALUE_CLASS[l.kind]}>{l.text}</span>
                </button>
              ))}
              {p.more > 0 && (
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className="block w-full text-left text-fg-subtle hover:underline"
                >
                  + {p.more} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
