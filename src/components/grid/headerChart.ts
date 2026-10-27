import type { Bin } from "../../lib/view";

/** Height of the bars drawn under a header's title, in px. */
export const CHART_HEIGHT = 10;

/**
 * Bar rectangles for a histogram in `rect` (left to right, bottom aligned).
 * The tallest bar fills the height; non-empty bins get at least 1 px so rare
 * values stay visible.
 */
export function histogramBars(
  bins: readonly Bin[],
  rect: { x: number; y: number; width: number; height: number },
  gap = 1,
): { x: number; y: number; width: number; height: number }[] {
  const max = bins.reduce((m, b) => Math.max(m, b.count), 0);
  if (bins.length === 0 || max === 0 || rect.width <= 0) return [];
  const step = rect.width / bins.length;
  const barWidth = Math.max(1, step - (step > 3 ? gap : 0));
  const out = [];
  for (let i = 0; i < bins.length; i++) {
    const count = bins[i]!.count;
    if (count === 0) continue;
    const h = Math.max(1, (count / max) * rect.height);
    out.push({ x: rect.x + i * step, y: rect.y + rect.height - h, width: barWidth, height: h });
  }
  return out;
}

export function paintHistogram(
  ctx: CanvasRenderingContext2D,
  bins: readonly Bin[],
  rect: { x: number; y: number; width: number; height: number },
  color: string,
): void {
  const bars = histogramBars(bins, rect);
  if (bars.length === 0) return;
  ctx.save();
  ctx.fillStyle = color;
  for (const b of bars) ctx.fillRect(b.x, b.y, b.width, b.height);
  ctx.restore();
}
