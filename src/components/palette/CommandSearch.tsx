import * as Popover from "@radix-ui/react-popover";
import { Command as CommandIcon, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { modKey } from "../../lib/platform";
import { allCommands, matchCommands, useCommands, type Command } from "../../stores/commands";

interface CommandSearchProps {
  /**
   * Set when the search is open, with the text to start from (Ctrl+K: "";
   * Shift+Ctrl+C: "Copy "); null when it's closed.
   */
  request: { query: string } | null;
  /** Asks to open it (a click, or typing in the box) with the text so far. */
  onOpen: (query: string) => void;
  onClose: () => void;
  /** Its width: the title bar's middle, or a fixed width beside the tabs. */
  className?: string;
}

/**
 * The search in the title bar: you type in this box, and the matching
 * actions drop down right under it, as in code editors (Ctrl+K). Arrows move
 * through them, Enter runs one, Escape closes and goes back to where you
 * were.
 */
export function CommandSearch({ request, onOpen, onClose, className }: CommandSearchProps) {
  const open = request !== null;
  const sources = useCommands((s) => s.sources);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Where the focus was before the search took it, to give it back.
  const before = useRef<HTMLElement | null>(null);
  const matches = useMemo(
    () => (open ? matchCommands(allCommands(sources), query) : []),
    [open, sources, query],
  );
  const current = Math.min(active, Math.max(0, matches.length - 1));

  // Opened (or asked again with other text): start from that text. Done while
  // rendering, when the request changes, so the box never shows stale text.
  const [seen, setSeen] = useState(request);
  if (request !== seen) {
    setSeen(request);
    setQuery(request?.query ?? "");
    setActive(0);
  }
  // ...and take the focus, with the cursor at the end of the text.
  useEffect(() => {
    const el = input.current;
    if (!request || !el) return;
    if (document.activeElement !== el) {
      before.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.focus();
    }
    requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
  }, [request]);

  const close = (giveBack: boolean) => {
    onClose();
    const back = before.current;
    before.current = null;
    // Back where it was, or nowhere (the page itself can't hold the focus).
    if (giveBack && back?.isConnected && back !== input.current && back !== document.body)
      back.focus();
    else if (giveBack) input.current?.blur();
  };
  const run = (c: Command | undefined) => {
    if (!c) return;
    close(true);
    // After the search has closed and given the focus back.
    setTimeout(c.run, 0);
  };

  return (
    <Popover.Root open={open} onOpenChange={(o) => (o ? onOpen(query) : close(false))}>
      <Popover.Anchor asChild>
        <div
          ref={box}
          className={cn(
            "flex h-7 items-center gap-2 rounded-[var(--radius)] border bg-bg px-2 text-fg-subtle transition-[border-color,box-shadow] duration-[var(--duration)]",
            open
              ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]"
              : "border-border hover:border-border-strong",
            className,
          )}
          // A click anywhere on the box goes to the text.
          onMouseDown={(e) => {
            if (e.target !== input.current) {
              e.preventDefault();
              input.current?.focus();
            }
          }}
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            ref={input}
            role="combobox"
            aria-label="Search commands"
            aria-expanded={open}
            aria-controls={open ? "command-list" : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              open && matches[current] ? `command-${matches[current].id}` : undefined
            }
            title={`Search actions (${modKey}+K)`}
            placeholder="Search…"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle"
            value={query}
            // A click opens it, even when the box already has the focus.
            onClick={() => !open && onOpen(query)}
            onFocus={(e) => {
              if (open) return;
              before.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
              onOpen(query);
            }}
            // Tab or a click elsewhere: the list closes (the focus stays where it went).
            onBlur={(e) => {
              if (open && !box.current?.contains(e.relatedTarget as Node | null)) close(false);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              if (!open) onOpen(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (!open) onOpen(query);
                else setActive(Math.min(current + 1, matches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(Math.max(current - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(matches[current]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close(true);
              }
            }}
          />
          {open ? (
            query !== "" && (
              <button
                type="button"
                aria-label="Clear the search"
                className="flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-sm)] hover:bg-hover hover:text-fg"
                // Keeps the focus in the box.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery("");
                  setActive(0);
                }}
              >
                <X className="size-3" aria-hidden />
              </button>
            )
          ) : (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px]" aria-hidden>
              {modKey === "⌘" ? <CommandIcon className="size-3" /> : "Ctrl+"}K
            </span>
          )}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          aria-label="Command palette"
          side="bottom"
          align="center"
          sideOffset={4}
          collisionPadding={8}
          // The focus stays in the box while the list shows.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Clicking the box itself isn't "outside".
          onInteractOutside={(e) => {
            if (box.current?.contains(e.target as Node)) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            close(true);
          }}
          // Clicks on the list (its scroll bar too) keep the focus in the box.
          onMouseDown={(e) => e.preventDefault()}
          // At least 30 rem wide, even when the box is narrower (a small window).
          style={{ width: "max(var(--radix-popper-anchor-width), min(30rem, calc(100vw - 16px)))" }}
          className="z-50 overflow-hidden rounded-[var(--radius-lg)] border border-border bg-bg text-[13px] shadow-[0_12px_32px_rgb(0_0_0/0.16)]"
        >
          <ul
            id="command-list"
            role="listbox"
            aria-label="Commands"
            className="max-h-80 overflow-y-auto py-1"
          >
            {matches.length === 0 && (
              <li className="px-3 py-2 text-fg-subtle">No matching commands</li>
            )}
            {matches.map((c, i) => (
              <li
                key={c.id}
                id={`command-${c.id}`}
                role="option"
                aria-selected={i === current}
                ref={i === current ? (el) => el?.scrollIntoView?.({ block: "nearest" }) : undefined}
                onMouseMove={() => i !== current && setActive(i)}
                // Keeps the focus in the box, so the click runs it.
                onMouseDown={(e) => e.preventDefault()}
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
