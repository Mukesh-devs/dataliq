import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDown,
  ArrowUp,
  ChartColumn,
  ClipboardCopy,
  Copy,
  Equal,
  EqualNot,
  RefreshCw,
  Table2,
  TextCursorInput,
} from "lucide-react";
import { useMemo } from "react";
import { COPY_FORMATS, type CopyFormat } from "../../lib/copyAs";
import { modKey } from "../../lib/platform";
import { MenuItem, MenuLabel, MenuSeparator } from "../ui/Menu";

/** A point or box in client coordinates that the menu opens at. */
export interface MenuAnchor {
  getBoundingClientRect: () => DOMRect;
}

export interface CellMenuActions {
  /** The selection without (Ctrl+C) or with a header row, as TSV. */
  copy: (headers: boolean) => void;
  copyAs: (format: CopyFormat) => void;
  copyValue: () => void;
  copyColumnName: () => void;
  /** Absent when the column can't be filtered by value. */
  filterEquals?: () => void;
  filterNotEquals?: () => void;
  sort?: (descending: boolean) => void;
  profile?: () => void;
  reload?: () => void;
}

interface CellMenuProps extends CellMenuActions {
  anchor: MenuAnchor;
  /** Display name of the clicked cell's column. */
  column: string;
  /** The clicked cell's value as shown ("null" for NULL), for the filter items. */
  valueText: string;
  onOpenChange: (open: boolean) => void;
}

/** Shortens a value for a menu label. */
function short(text: string): string {
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

/** Right-click menu on a grid cell: copy, filter by the value, sort, profile. */
export function CellMenu({
  anchor,
  column,
  valueText,
  onOpenChange,
  copy,
  copyAs,
  copyValue,
  copyColumnName,
  filterEquals,
  filterNotEquals,
  sort,
  profile,
  reload,
}: CellMenuProps) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const choose = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };
  const shown = valueText === "" ? '""' : short(valueText);
  return (
    <Popover.Root open onOpenChange={onOpenChange}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<MenuAnchor>} />
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="bottom"
          sideOffset={2}
          collisionPadding={8}
          role="menu"
          aria-label="Cell"
          className="z-50 max-h-[min(560px,80vh)] min-w-60 overflow-y-auto rounded-[var(--radius-lg)] border border-border bg-bg p-1 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <MenuItem
            icon={<Copy />}
            onSelect={choose(() => copy(false))}
            shortcut={`${modKey}+C`}
            autoFocus
          >
            Copy
          </MenuItem>
          <MenuItem icon={<Table2 />} onSelect={choose(() => copy(true))}>
            Copy with headers
          </MenuItem>
          <MenuItem icon={<ClipboardCopy />} onSelect={choose(copyValue)}>
            Copy cell value
          </MenuItem>
          <MenuItem icon={<TextCursorInput />} onSelect={choose(copyColumnName)}>
            Copy column name
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Copy selection as</MenuLabel>
          {COPY_FORMATS.map((f) => (
            <MenuItem key={f.format} icon={<span />} onSelect={choose(() => copyAs(f.format))}>
              {f.label}
            </MenuItem>
          ))}
          {(filterEquals || sort || profile) && <MenuSeparator />}
          {filterEquals && (
            <MenuItem icon={<Equal />} onSelect={choose(filterEquals)}>
              Only rows where {column} = {shown}
            </MenuItem>
          )}
          {filterNotEquals && (
            <MenuItem icon={<EqualNot />} onSelect={choose(filterNotEquals)}>
              Exclude {shown}
            </MenuItem>
          )}
          {sort && (
            <>
              <MenuItem icon={<ArrowUp />} onSelect={choose(() => sort(false))}>
                Sort {column} ascending
              </MenuItem>
              <MenuItem icon={<ArrowDown />} onSelect={choose(() => sort(true))}>
                Sort {column} descending
              </MenuItem>
            </>
          )}
          {profile && (
            <MenuItem icon={<ChartColumn />} onSelect={choose(profile)}>
              Column profile
            </MenuItem>
          )}
          {reload && (
            <>
              <MenuSeparator />
              <MenuItem icon={<RefreshCw />} onSelect={choose(reload)}>
                Reload file
              </MenuItem>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
