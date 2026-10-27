/**
 * How a tab shows its columns: order, hidden and pinned columns, display
 * names and widths. Purely a display choice: filters, sorting and the data
 * keep using the real column names. `visible()` gives the shown columns in
 * order, e.g. for export.
 */
export interface ColumnLayout {
  /** Every column in display order, hidden ones included (they keep their place). */
  order: string[];
  hidden: string[];
  /** Pinned (frozen) columns; always first in `order`. */
  pinned: string[];
  /** Display names that differ from the column name. */
  labels: Record<string, string>;
  /** Widths set by the user (resize or auto-fit), in px. */
  widths: Record<string, number>;
}

export function defaultLayout(columns: string[]): ColumnLayout {
  return { order: [...columns], hidden: [], pinned: [], labels: {}, widths: {} };
}

/** The layout for `columns`: unknown names dropped, new columns appended. */
export function reconcile(layout: ColumnLayout | undefined, columns: string[]): ColumnLayout {
  if (!layout) return defaultLayout(columns);
  const known = new Set(columns);
  const order = layout.order.filter((c) => known.has(c));
  for (const c of columns) if (!order.includes(c)) order.push(c);
  const keep = <T>(r: Record<string, T>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => known.has(k)));
  return {
    order,
    hidden: layout.hidden.filter((c) => known.has(c)),
    pinned: layout.pinned.filter((c) => known.has(c)),
    labels: keep(layout.labels),
    widths: keep(layout.widths),
  };
}

/** Shown columns, in display order (pinned first). */
export function visible(layout: ColumnLayout): string[] {
  const hidden = new Set(layout.hidden);
  return layout.order.filter((c) => !hidden.has(c));
}

/** How many of the shown columns are pinned (Glide's `freezeColumns`). */
export function pinnedCount(layout: ColumnLayout): number {
  const hidden = new Set(layout.hidden);
  return layout.pinned.filter((c) => !hidden.has(c)).length;
}

export function label(layout: ColumnLayout, column: string): string {
  return layout.labels[column] ?? column;
}

export function setHidden(layout: ColumnLayout, column: string, hidden: boolean): ColumnLayout {
  const rest = layout.hidden.filter((c) => c !== column);
  // Never hide the last shown column.
  if (hidden && visible(layout).filter((c) => c !== column).length === 0) return layout;
  return { ...layout, hidden: hidden ? [...rest, column] : rest };
}

export function showAll(layout: ColumnLayout): ColumnLayout {
  return { ...layout, hidden: [] };
}

/** Keeps `order` as pinned columns (in pin order) followed by the rest. */
function withPinned(layout: ColumnLayout, pinned: string[]): ColumnLayout {
  const rest = layout.order.filter((c) => !pinned.includes(c));
  return { ...layout, pinned, order: [...pinned, ...rest] };
}

/** Pins a column after the already pinned ones, or unpins it to just after them. */
export function setPinned(layout: ColumnLayout, column: string, pinned: boolean): ColumnLayout {
  const others = layout.pinned.filter((c) => c !== column);
  return withPinned(layout, pinned ? [...others, column] : others);
}

/**
 * Moves the shown column at `from` to shown position `to` (Glide's
 * `onColumnMoved`). Dropping it among the pinned columns pins it; dropping it
 * after them unpins it.
 */
export function move(layout: ColumnLayout, from: number, to: number): ColumnLayout {
  const shown = visible(layout);
  const column = shown[from];
  if (column === undefined || from === to) return layout;
  const target = [...shown];
  target.splice(from, 1);
  target.splice(to, 0, column);
  // Rebuild the full order: hidden columns stay right after the shown column
  // they followed.
  const order: string[] = [];
  const hidden = new Set(layout.hidden);
  const leading = layout.order.slice(
    0,
    layout.order.findIndex((c) => !hidden.has(c)),
  );
  order.push(...leading);
  for (const c of target) {
    order.push(c);
    let i = layout.order.indexOf(c) + 1;
    while (i < layout.order.length && hidden.has(layout.order[i]!)) order.push(layout.order[i++]!);
  }
  // Pinned if dropped inside the pinned block (which includes the column
  // itself when it was pinned already).
  const wasPinned = layout.pinned.includes(column);
  const pinnedOthers = layout.pinned.filter((c) => c !== column && !hidden.has(c)).length;
  const pinnedNow = to < pinnedOthers + (wasPinned ? 1 : 0);
  const pinned = order.filter((c) => (c === column ? pinnedNow : layout.pinned.includes(c)));
  return withPinned({ ...layout, order }, pinned);
}

export function rename(layout: ColumnLayout, column: string, name: string): ColumnLayout {
  const labels = { ...layout.labels };
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === column) delete labels[column];
  else labels[column] = trimmed;
  return { ...layout, labels };
}

export const MIN_WIDTH = 50;
export const MAX_WIDTH = 500;

export function setWidth(layout: ColumnLayout, column: string, width: number): ColumnLayout {
  const w = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
  return { ...layout, widths: { ...layout.widths, [column]: w } };
}

/**
 * Width that fits a header and some values: the widest of the header (text
 * plus `headerExtra` for its icon and menu) and the values, plus cell padding.
 */
export function fitWidth(
  header: string,
  values: string[],
  measure: { header: (s: string) => number; cell: (s: string) => number },
  opts: { padding: number; headerExtra: number },
): number {
  let w = measure.header(header) + opts.headerExtra;
  for (const v of values) w = Math.max(w, measure.cell(v));
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + 2 * opts.padding)));
}
