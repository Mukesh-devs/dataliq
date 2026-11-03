import * as Popover from "@radix-ui/react-popover";
import {
  Check,
  ChartColumn,
  LoaderCircle,
  MemoryStick,
  Monitor,
  Moon,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { engineMemory, type MemoryUsage } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import { STAT_LABELS, STAT_ORDER, statItems } from "../../lib/selectionStats";
import { useNotice } from "../../stores/notice";
import { useSelection } from "../../stores/selection";
import { useSettings, type ThemePreference } from "../../stores/settings";
import { Button, IconButton } from "../ui/Button";

const themeIcon: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };
const themeLabel: Record<ThemePreference, string> = {
  system: "Theme: follow system",
  light: "Theme: light",
  dark: "Theme: dark",
};

interface StatusBarProps {
  message: string;
  /** A button after the message, e.g. "Cancel" while a query runs. */
  action?: { label: string; run: () => void };
}

export function StatusBar({ message, action }: StatusBarProps) {
  // A short-lived notice ("Copied 12 rows as CSV") replaces the message.
  const notice = useNotice((s) => s.text);
  const theme = useSettings((s) => s.theme);
  const cycleTheme = useSettings((s) => s.cycleTheme);
  const headerCharts = useSettings((s) => s.headerCharts);
  const setHeaderCharts = useSettings((s) => s.setHeaderCharts);
  const Icon = themeIcon[theme];
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[12px] text-fg-muted">
      <span role="status" className="tabular truncate">
        {notice ?? message}
      </span>
      {action && (
        <Button size="sm" variant="ghost" className="h-5 px-1.5" onClick={action.run}>
          {action.label}
        </Button>
      )}
      <span className="flex-1" />
      <SelectionStatsStrip />
      <MemoryIndicator />
      <IconButton
        label={headerCharts ? "Hide column histograms" : "Show column histograms"}
        aria-pressed={headerCharts}
        onClick={() => setHeaderCharts(!headerCharts)}
        className={headerCharts ? "size-5 text-fg" : "size-5"}
      >
        <ChartColumn className="size-3.5" aria-hidden />
      </IconButton>
      <IconButton label={themeLabel[theme]} onClick={cycleTheme} className="size-5">
        <Icon className="size-3.5" aria-hidden />
      </IconButton>
    </footer>
  );
}

/**
 * Count, sum, average, min and max of the grid's selection (like a
 * spreadsheet). Click a value to copy it; right-click or the sliders button
 * picks which ones show.
 */
function SelectionStatsStrip() {
  const summary = useSelection((s) => s.summary);
  const pending = useSelection((s) => s.pending);
  const error = useSelection((s) => s.error);
  const shown = useSelection((s) => s.shown);
  const notice = useNotice((s) => s.show);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const items = useMemo(() => (summary ? statItems(summary, shown) : []), [summary, shown]);
  if (!summary && !pending && !error) return null;
  const copy = (label: string, text: string, value: string) =>
    void navigator.clipboard.writeText(value).then(
      () => notice(`Copied ${label} ${text}`),
      (e: unknown) => notice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`),
    );
  return (
    <div
      role="group"
      aria-label="Selection statistics"
      aria-busy={pending}
      className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
    >
      {pending && (
        <LoaderCircle className="mr-1 size-3 shrink-0 animate-spin" aria-label="Adding up" />
      )}
      {!summary && pending && <span className="whitespace-nowrap">Adding up…</span>}
      {error && (
        <span className="truncate whitespace-nowrap" title={error}>
          Couldn’t add up the selection
        </span>
      )}
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          title={`Copy ${it.label.toLowerCase()}: ${it.copy}`}
          onClick={() => copy(it.label.toLowerCase(), it.text, it.copy)}
          className={`flex h-5 max-w-56 shrink-0 items-center gap-1 rounded-[var(--radius)] px-1.5 whitespace-nowrap hover:bg-hover ${pending ? "opacity-60" : ""}`}
        >
          <span className="text-fg-subtle">{it.label}:</span>
          <span className="tabular truncate text-fg">{it.text}</span>
        </button>
      ))}
      <IconButton
        label="Choose selection statistics"
        className="size-5 shrink-0"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.left, y: r.top });
        }}
      >
        <SlidersHorizontal className="size-3.5" aria-hidden />
      </IconButton>
      {menuAt && <StatsMenu at={menuAt} onClose={() => setMenuAt(null)} />}
    </div>
  );
}

/** Which statistics the status bar shows. */
function StatsMenu({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const shown = useSelection((s) => s.shown);
  const toggle = useSelection((s) => s.toggle);
  const anchor = useMemo(
    () => ({ current: { getBoundingClientRect: () => new DOMRect(at.x, at.y, 1, 1) } }),
    [at],
  );
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          role="menu"
          aria-label="Selection statistics to show"
          className="z-50 min-w-44 rounded-[var(--radius-lg)] border border-border bg-bg p-1 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          {STAT_ORDER.map((key, i) => {
            const on = shown.includes(key);
            return (
              <button
                key={key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                autoFocus={i === 0}
                // The last one shown stays.
                aria-disabled={on && shown.length === 1}
                onClick={() => toggle(key)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const items = [
                    ...(e.currentTarget
                      .closest('[role="menu"]')
                      ?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? []),
                  ];
                  const at = items.indexOf(e.currentTarget);
                  const step = e.key === "ArrowDown" ? 1 : items.length - 1;
                  items[(at + step) % items.length]?.focus();
                }}
                className="flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-1 text-left text-fg outline-none hover:bg-hover focus-visible:bg-hover"
              >
                <Check className={`size-3.5 ${on ? "text-accent" : "invisible"}`} aria-hidden />
                {STAT_LABELS[key]}
                {key === "distinct" && (
                  <span className="ml-auto pl-2 text-[11px] text-fg-subtle">one column</span>
                )}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** How often the memory indicator asks (only while the window is visible). */
export const MEMORY_POLL_MS = 3000;
/** Share of the limit from which the indicator stands out. */
const MEMORY_HIGH = 0.8;

/**
 * DuckDB's memory in use against its limit, and what a big query spilled to
 * the temporary folder. Hidden when the engine can't say.
 */
function MemoryIndicator() {
  const [memory, setMemory] = useState<MemoryUsage | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      engineMemory().then(
        (m) => alive && setMemory(m),
        () => alive && setMemory(null),
      );
    };
    poll();
    const timer = setInterval(poll, MEMORY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!memory) return null;
  const { usedBytes, limitBytes, spilledBytes } = memory;
  const high = limitBytes !== null && usedBytes >= limitBytes * MEMORY_HIGH;
  const detail =
    `DuckDB memory: ${formatBytes(usedBytes)} in use` +
    (limitBytes !== null ? ` of ${formatBytes(limitBytes)} (Settings › Memory limit)` : "") +
    (spilledBytes > 0 ? `; ${formatBytes(spilledBytes)} spilled to the temporary folder` : "");
  return (
    <span
      role="img"
      aria-label={detail}
      title={detail}
      className={`flex shrink-0 items-center gap-1 whitespace-nowrap ${high ? "font-medium text-warning" : ""}`}
    >
      <MemoryStick className="size-3.5" aria-hidden />
      <span className="tabular">
        {formatBytes(usedBytes)}
        {limitBytes !== null && (
          <span className="text-fg-subtle"> / {formatBytes(limitBytes)}</span>
        )}
      </span>
      {spilledBytes > 0 && (
        <span className="tabular text-fg-subtle">· {formatBytes(spilledBytes)} on disk</span>
      )}
    </span>
  );
}
