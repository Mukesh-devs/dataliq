import { useState, type ReactNode } from "react";
import { windowRange } from "../../lib/virtual";

interface VirtualListProps {
  count: number;
  /** Every row's height, in px. */
  rowHeight: number;
  /** The list's height when it has more rows than fit. */
  height: number;
  /** Rows rendered beyond each edge, so keyboard focus can move on. */
  overscan?: number;
  renderRow: (index: number) => ReactNode;
  "aria-label": string;
  className?: string;
}

/**
 * A list that only renders the rows in view (fixed row height): thousands
 * of columns cost the same as a screenful. Rows keep their list position
 * for assistive tech (aria-setsize / aria-posinset).
 */
export function VirtualList({
  count,
  rowHeight,
  height,
  overscan = 8,
  renderRow,
  className,
  ...aria
}: VirtualListProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const { first, last } = windowRange(scrollTop, height, rowHeight, count, overscan);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <li
        key={i}
        aria-setsize={count}
        aria-posinset={i + 1}
        className="absolute right-0 left-0"
        style={{ top: i * rowHeight, height: rowHeight }}
      >
        {renderRow(i)}
      </li>,
    );
  }
  return (
    <div
      className={className}
      style={{ height: Math.min(height, count * rowHeight), overflowY: "auto" }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      data-testid="virtual-list"
    >
      <ul
        aria-label={aria["aria-label"]}
        className="relative"
        style={{ height: count * rowHeight }}
      >
        {rows}
      </ul>
    </div>
  );
}
