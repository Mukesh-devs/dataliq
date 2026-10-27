import * as Popover from "@radix-ui/react-popover";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { allCommands, matchCommands, useCommands, type Command } from "../../stores/commands";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Text to start with, e.g. "Copy " for the copy-as choices. */
  initialQuery?: string;
}

/** Ctrl+K: type to find any action, Enter to run it. */
export function CommandPalette({ open, onOpenChange, initialQuery = "" }: CommandPaletteProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor className="pointer-events-none fixed top-12 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Command palette"
          side="bottom"
          align="center"
          className="z-50 w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-bg text-[13px] shadow-[0_12px_32px_rgb(0_0_0/0.16)]"
        >
          {/* Mounted only while open, so each opening starts empty. */}
          <PaletteBody initialQuery={initialQuery} onDone={() => onOpenChange(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PaletteBody({ initialQuery, onDone }: { initialQuery: string; onDone: () => void }) {
  const sources = useCommands((s) => s.sources);
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => matchCommands(allCommands(sources), query), [sources, query]);
  const current = Math.min(active, Math.max(0, matches.length - 1));

  const run = (c: Command | undefined) => {
    if (!c) return;
    onDone();
    // After the palette has closed and given focus back.
    setTimeout(c.run, 0);
  };

  return (
    <div className="flex flex-col">
      <input
        autoFocus
        role="combobox"
        aria-label="Search commands"
        aria-expanded
        aria-controls="command-list"
        aria-activedescendant={matches[current] ? `command-${matches[current].id}` : undefined}
        placeholder="Type a command…"
        className="h-10 border-b border-border bg-bg px-3 text-fg outline-none placeholder:text-fg-subtle"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(current + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(current - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(matches[current]);
          }
        }}
      />
      <ul
        id="command-list"
        role="listbox"
        aria-label="Commands"
        className="max-h-80 overflow-y-auto py-1"
      >
        {matches.length === 0 && <li className="px-3 py-2 text-fg-subtle">No matching commands</li>}
        {matches.map((c, i) => (
          <li
            key={c.id}
            id={`command-${c.id}`}
            role="option"
            aria-selected={i === current}
            ref={i === current ? (el) => el?.scrollIntoView?.({ block: "nearest" }) : undefined}
            onMouseMove={() => i !== current && setActive(i)}
            onClick={() => run(c)}
            className={cn(
              "flex cursor-default items-center gap-3 px-3 py-1.5",
              i === current ? "bg-accent-soft text-fg" : "text-fg-muted",
            )}
          >
            <span className="flex-1 truncate">{c.title}</span>
            <span className="text-[11px] text-fg-subtle">{c.group}</span>
            {c.shortcut && (
              <kbd className="rounded-[var(--radius-sm)] border border-border px-1 font-sans text-[11px] text-fg-subtle">
                {c.shortcut}
              </kbd>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
