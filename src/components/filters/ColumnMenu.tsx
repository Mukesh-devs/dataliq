import * as Popover from "@radix-ui/react-popover";
import { ArrowDown, ArrowUp, ListFilter, Plus, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { SortKey } from "../../lib/view";
import type { Anchor } from "./FilterEditor";

interface ColumnMenuProps {
  column: string;
  anchor: Anchor;
  sort: SortKey[];
  onOpenChange: (open: boolean) => void;
  /** New sort for the view. */
  onSort: (sort: SortKey[]) => void;
  onFilter: () => void;
}

/** The column header menu (▼ or right-click): sort and filter. */
export function ColumnMenu({
  column,
  anchor,
  sort,
  onOpenChange,
  onSort,
  onFilter,
}: ColumnMenuProps) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const current = sort.find((k) => k.column === column);
  const others = sort.filter((k) => k.column !== column);
  const choose = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };
  return (
    <Popover.Root open onOpenChange={onOpenChange}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<Anchor>} />
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={2}
          collisionPadding={8}
          role="menu"
          aria-label={`${column} column`}
          // The filter editor may open next and takes focus itself.
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-50 min-w-52 rounded-[var(--radius-lg)] border border-border bg-bg p-1 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <Item icon={<ArrowUp />} onSelect={choose(() => onSort([{ column }]))} autoFocus>
            Sort ascending
          </Item>
          <Item
            icon={<ArrowDown />}
            onSelect={choose(() => onSort([{ column, descending: true }]))}
          >
            Sort descending
          </Item>
          {others.length > 0 && !current && (
            <Item icon={<Plus />} onSelect={choose(() => onSort([...sort, { column }]))}>
              Add to sort
            </Item>
          )}
          {current && (
            <Item icon={<X />} onSelect={choose(() => onSort(others))}>
              Remove from sort
            </Item>
          )}
          <div className="my-1 h-px bg-border" role="separator" />
          <Item icon={<ListFilter />} onSelect={choose(onFilter)}>
            Filter…
          </Item>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Item({
  icon,
  children,
  onSelect,
  autoFocus,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  autoFocus?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      onClick={onSelect}
      onKeyDown={(e) => {
        // Arrow keys move between items, like a native menu.
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = [
          ...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
            []),
        ];
        const i = items.indexOf(e.currentTarget);
        const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
        next?.focus();
      }}
      className="flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-1 text-left text-fg outline-none hover:bg-hover focus-visible:bg-hover [&_svg]:size-3.5 [&_svg]:text-fg-muted"
    >
      {icon}
      {children}
    </button>
  );
}
