import type { WheelEvent } from "react";

/**
 * Lets the mouse wheel scroll a row sideways (a toolbar or the tabs that
 * don't fit): most mice only have a vertical wheel. Does nothing when the row
 * fits, or when the wheel already moves sideways (trackpads, Shift+wheel).
 */
export function scrollSideways(e: WheelEvent<HTMLElement>): void {
  const row = e.currentTarget;
  if (!e.deltaY || e.shiftKey || row.scrollWidth <= row.clientWidth) return;
  row.scrollLeft += e.deltaY;
}
