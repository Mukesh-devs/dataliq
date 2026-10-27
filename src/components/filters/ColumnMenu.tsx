import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDown,
  ArrowUp,
  ChartColumn,
  EyeOff,
  ListFilter,
  MoveHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  WandSparkles,
  X,
} from "lucide-react";
import { useMemo } from "react";
import { MenuItem as Item, MenuSeparator } from "../ui/Menu";
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
  /** Column management; items are shown only when their handler is given. */
  pinned?: boolean;
  onPin?: (pinned: boolean) => void;
  /** Absent when this is the only column shown. */
  onHide?: () => void;
  onRename?: () => void;
  onAutoFit?: () => void;
  /** Opens the column's statistics. */
  onProfile?: () => void;
  /** Opens the cleaning steps with this column picked. */
  onClean?: () => void;
}

/** The column header menu (▼ or right-click): sort and filter. */
export function ColumnMenu({
  column,
  anchor,
  sort,
  onOpenChange,
  onSort,
  onFilter,
  pinned,
  onPin,
  onHide,
  onRename,
  onAutoFit,
  onProfile,
  onClean,
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
          <MenuSeparator />
          <Item icon={<ListFilter />} onSelect={choose(onFilter)}>
            Filter…
          </Item>
          {onProfile && (
            <Item icon={<ChartColumn />} onSelect={choose(onProfile)}>
              Column profile
            </Item>
          )}
          {onClean && (
            <Item icon={<WandSparkles />} onSelect={choose(onClean)}>
              Clean column…
            </Item>
          )}
          {(onPin || onHide || onRename || onAutoFit) && <MenuSeparator />}
          {onPin && (
            <Item icon={pinned ? <PinOff /> : <Pin />} onSelect={choose(() => onPin(!pinned))}>
              {pinned ? "Unpin column" : "Pin to the left"}
            </Item>
          )}
          {onHide && (
            <Item icon={<EyeOff />} onSelect={choose(onHide)}>
              Hide column
            </Item>
          )}
          {onRename && (
            <Item icon={<Pencil />} onSelect={choose(onRename)}>
              Rename…
            </Item>
          )}
          {onAutoFit && (
            <Item icon={<MoveHorizontal />} onSelect={choose(onAutoFit)}>
              Auto-fit width
            </Item>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
