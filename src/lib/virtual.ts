/** Rows [first, last) to render for a scroll position (see VirtualList). */
export function windowRange(
  scrollTop: number,
  height: number,
  rowHeight: number,
  count: number,
  overscan: number,
): { first: number; last: number } {
  const first = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  return { first, last: Math.max(first, last) };
}

/** Charts computed before the grid says which columns are in view. */
export const FIRST_CHARTS = 30;

/**
 * The chart columns to compute: those in view, in file order (the first
 * {@link FIRST_CHARTS} before the grid has reported what it shows).
 */
export function chartsFor(chartColumns: readonly string[], inView: ReadonlySet<string> | null) {
  return inView ? chartColumns.filter((c) => inView.has(c)) : chartColumns.slice(0, FIRST_CHARTS);
}
