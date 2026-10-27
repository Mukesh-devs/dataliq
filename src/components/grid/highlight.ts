/**
 * Where `term` occurs in `text`, case-insensitively, as [start, end) offsets
 * into `text`. Matches what the backend's search does (lower() on both
 * sides). Empty when lower-casing changes the text's length (some Unicode
 * letters), since offsets could no longer be mapped back.
 */
export function findMatches(text: string, term: string): [number, number][] {
  if (!term || !text) return [];
  const hay = text.toLowerCase();
  const needle = term.toLowerCase();
  if (hay.length !== text.length) return [];
  const out: [number, number][] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return out;
    out.push([i, i + needle.length]);
    from = i + needle.length;
  }
}

/**
 * Paints a highlight behind each match of `term` in a left-aligned text
 * cell, before the cell's own text is drawn on top.
 */
export function paintMatches(
  ctx: CanvasRenderingContext2D,
  text: string,
  term: string,
  rect: { x: number; y: number; width: number; height: number },
  opts: { font: string; padding: number; color: string },
): number {
  const matches = findMatches(text, term);
  if (matches.length === 0) return 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.font = opts.font;
  ctx.fillStyle = opts.color;
  const left = rect.x + opts.padding;
  for (const [start, end] of matches) {
    const x = left + ctx.measureText(text.slice(0, start)).width;
    if (x > rect.x + rect.width) break;
    const w = ctx.measureText(text.slice(start, end)).width;
    ctx.fillRect(x, rect.y + 4, w, rect.height - 8);
  }
  ctx.restore();
  return matches.length;
}
