import { NOT_LOADED, type RowSource } from "./rowSource";

/** Most rows copied at once ("Copy as …"); more are cut with a note. */
export const MAX_COPY_ROWS = 100_000;

/** Rows loaded and read per step: well within the paged source's cache. */
const CHUNK = 5_000;

/** Ascending row indices as runs of consecutive rows, [start, end). */
export function runs(rows: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && r === last[1]) last[1] = r + 1;
    else out.push([r, r + 1]);
  }
  return out;
}

/**
 * Reads the values of `rows` (ascending) in source columns `cols`, loading
 * them chunk by chunk. Fails if a page can't be loaded.
 */
export async function readRows(
  source: RowSource,
  rows: readonly number[],
  cols: readonly number[],
): Promise<unknown[][]> {
  const out: unknown[][] = [];
  for (const [start, end] of runs(rows)) {
    for (let from = start; from < end; from += CHUNK) {
      const to = Math.min(end, from + CHUNK);
      await source.load(from, to);
      for (let r = from; r < to; r++) {
        out.push(
          cols.map((c) => {
            const v = source.getValue(r, c);
            if (v === NOT_LOADED) throw new Error(`Row ${r + 1} could not be loaded.`);
            return v;
          }),
        );
      }
    }
  }
  return out;
}
