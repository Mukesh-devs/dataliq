import type { ReactNode } from "react";

/** A menu row: icon and label; arrow keys move between items like a native menu. */
export function MenuItem({
  icon,
  children,
  onSelect,
  autoFocus,
  shortcut,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  autoFocus?: boolean;
  /** Shown on the right, e.g. "Ctrl+C". */
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = [
          ...(e.currentTarget
            .closest('[role="menu"]')
            ?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
        ];
        const i = items.indexOf(e.currentTarget);
        const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
        next?.focus();
      }}
      className="flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-1 text-left text-fg outline-none hover:bg-hover focus-visible:bg-hover [&_svg]:size-3.5 [&_svg]:text-fg-muted"
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="text-[11px] text-fg-subtle">{shortcut}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}

/** A label for a group of items. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
      {children}
    </div>
  );
}
