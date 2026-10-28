import * as Menubar from "@radix-ui/react-menubar";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ResolvedItem, ResolvedMenu } from "../../lib/menus";

interface MenuBarProps {
  menus: ResolvedMenu[];
  /** Runs the command with this id (see `MENUS`). */
  onRun: (id: string) => void;
}

const contentClass =
  "z-50 min-w-[14rem] max-w-[24rem] rounded-[var(--radius-lg)] border border-border bg-bg p-1 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]";
const itemClass =
  "flex h-7 cursor-default items-center gap-2 rounded-[var(--radius)] px-2 text-fg outline-none select-none data-[disabled]:text-fg-subtle data-[highlighted]:bg-hover data-[state=open]:bg-hover";

function Items({ items, onRun }: { items: ResolvedItem[]; onRun: (id: string) => void }) {
  return items.map((item, i) => {
    if (item.kind === "separator")
      return <Menubar.Separator key={`sep-${i}`} className="my-1 h-px bg-border" />;
    if (item.kind === "submenu")
      return (
        <Menubar.Sub key={item.label}>
          <Menubar.SubTrigger className={itemClass}>
            <span className="flex-1 truncate">{item.label}</span>
            <ChevronRight className="size-3.5 text-fg-muted" aria-hidden />
          </Menubar.SubTrigger>
          <Menubar.Portal>
            <Menubar.SubContent className={contentClass} sideOffset={4} alignOffset={-5}>
              <Items items={item.items} onRun={onRun} />
            </Menubar.SubContent>
          </Menubar.Portal>
        </Menubar.Sub>
      );
    return (
      <Menubar.Item
        key={item.id}
        disabled={!item.enabled}
        // After the menu has closed, so a dialog the command opens keeps the focus.
        onSelect={() => setTimeout(() => onRun(item.id), 0)}
        className={itemClass}
        title={item.id.startsWith("recent:") ? item.id.slice("recent:".length) : undefined}
      >
        <span className="flex-1 truncate">{item.label}</span>
        {item.shortcut && <span className="ml-6 text-[11px] text-fg-subtle">{item.shortcut}</span>}
      </Menubar.Item>
    );
  });
}

/**
 * The menu bar on Windows and Linux, at the start of the tab row (macOS has
 * the native one). Alt on its own or F10 moves the focus to it, as in native
 * apps; arrows then move between menus and items.
 */
export function MenuBar({ menus, onRun }: MenuBarProps) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let altAlone = false;
    const down = (e: KeyboardEvent) => {
      altAlone = e.key === "Alt" && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      if (e.key === "F10" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        first.current?.focus();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt" && altAlone) {
        e.preventDefault();
        // After the key event: focused inside it, the first arrow is lost.
        setTimeout(() => first.current?.focus(), 0);
      }
      altAlone = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  return (
    <Menubar.Root className="flex shrink-0 items-center gap-0.5" aria-label="Menu bar">
      {menus.map((menu, i) => (
        <Menubar.Menu key={menu.label}>
          <Menubar.Trigger
            ref={i === 0 ? first : undefined}
            className="h-6 rounded-[var(--radius)] px-2 text-[13px] text-fg-muted outline-none select-none hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
          >
            {menu.label}
          </Menubar.Trigger>
          <Menubar.Portal>
            <Menubar.Content
              className={contentClass}
              align="start"
              sideOffset={6}
              // The command decides where the focus goes.
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <Items items={menu.items} onRun={onRun} />
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
      ))}
    </Menubar.Root>
  );
}
