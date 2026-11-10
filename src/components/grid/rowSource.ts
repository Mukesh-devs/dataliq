import type { Table } from "apache-arrow";
import { cellValue, describeColumns, type ColumnInfo } from "../../lib/arrow";

/** Marker for a cell whose page has not arrived yet. */
export const NOT_LOADED: unique symbol = Symbol("not-loaded");
export type CellResult = unknown | typeof NOT_LOADED;

/**
 * Rows for the grid. The grid never holds more than a window of rows: it asks
 * for values by (row, col) and tells the source which rows are visible.
 */
export interface RowSource {
  readonly rowCount: number;
  readonly columns: ColumnInfo[];
  getValue(row: number, col: number): CellResult;
  /** Loads rows [start, end) if needed (plus prefetch). */
  ensure(start: number, end: number): void;
  /** Resolves once rows [start, end) are loaded (used for copy). */
  load(start: number, end: number): Promise<void>;
  /** Called with the row range of each page that arrives. */
  subscribe(listener: (start: number, end: number) => void): () => void;
  /** Called with a message when a page fails to load. */
  onError?(listener: (message: string) => void): () => void;
  dispose(): void;
}

/** A fully loaded Arrow table, e.g. the instant preview. */
export class StaticRowSource implements RowSource {
  readonly rowCount: number;
  readonly columns: ColumnInfo[];
  constructor(private readonly table: Table) {
    this.rowCount = table.numRows;
    this.columns = describeColumns(table);
  }
  getValue(row: number, col: number): CellResult {
    return cellValue(this.table, row, col);
  }
  ensure(): void {}
  load(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(): () => void {
    return () => {};
  }
  dispose(): void {}
}

export type FetchPage = (start: number, count: number) => Promise<Table>;

export interface PagedOptions {
  rowCount: number;
  columns: ColumnInfo[];
  fetchPage: FetchPage;
  /** Rows per request. */
  pageSize?: number;
  /** Pages kept in memory (LRU). */
  maxPages?: number;
  /** Pages loaded on each side of the visible range while not scrolling. */
  prefetchPages?: number;
  /** Pages loaded ahead, at most, while scrolling fast. */
  maxAhead?: number;
  /** Page requests sent at once; the rest wait their turn (and may be dropped). */
  maxInflight?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * Pages rows from the backend with an LRU of pages. Pages around the
 * visible range are loaded ahead of time: more of them in the direction of
 * a scroll, the faster it is. At most `maxInflight` requests are sent at
 * once; a waiting request for a page that has scrolled out of reach is
 * dropped, so a fast drag through millions of rows only loads where it
 * stops. Requests for the same page are de-duplicated.
 */
export class PagedRowSource implements RowSource {
  readonly rowCount: number;
  readonly columns: ColumnInfo[];
  readonly pageSize: number;
  private readonly maxPages: number;
  private readonly prefetchPages: number;
  private readonly maxAhead: number;
  private readonly maxInflight: number;
  private readonly fetchPage: FetchPage;
  private readonly now: () => number;
  /** Insertion order = recency (Map keeps insertion order). */
  private readonly pages = new Map<number, Table>();
  private readonly inflight = new Map<number, Promise<void>>();
  /** Pages wanted for the current view, most wanted first (not sent yet). */
  private queue: number[] = [];
  private readonly listeners = new Set<(start: number, end: number) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  private disposed = false;
  /** The last visible first page and when it was seen (scroll speed). */
  private last: { page: number; at: number } | null = null;
  /** +1 scrolling down, -1 up, 0 still. */
  private direction = 0;
  /** Pages read ahead at the last scroll step. */
  private ahead = 1;
  /** Number of fetches issued, for tests and diagnostics. */
  fetches = 0;
  /** Waiting requests dropped because the view moved on. */
  dropped = 0;
  errors: unknown[] = [];

  constructor(opts: PagedOptions) {
    this.rowCount = opts.rowCount;
    this.columns = opts.columns;
    this.fetchPage = opts.fetchPage;
    this.pageSize = opts.pageSize ?? 500;
    this.maxPages = opts.maxPages ?? 64;
    this.prefetchPages = opts.prefetchPages ?? 1;
    this.maxAhead = Math.max(this.prefetchPages, opts.maxAhead ?? 4);
    this.maxInflight = Math.max(1, opts.maxInflight ?? 4);
    this.now = opts.now ?? (() => performance.now());
  }

  private pageOf(row: number): number {
    return Math.floor(row / this.pageSize);
  }

  getValue(row: number, col: number): CellResult {
    const index = this.pageOf(row);
    const page = this.pages.get(index);
    if (!page) return NOT_LOADED;
    // Refresh recency.
    this.pages.delete(index);
    this.pages.set(index, page);
    return cellValue(page, row - index * this.pageSize, col);
  }

  isLoaded(row: number): boolean {
    return this.pages.has(this.pageOf(row));
  }

  get cachedPages(): number {
    return this.pages.size;
  }

  /** Requests sent and not answered yet. */
  get pending(): number {
    return this.inflight.size;
  }

  private request(index: number): Promise<void> {
    if (this.pages.has(index)) return Promise.resolve();
    const existing = this.inflight.get(index);
    if (existing) return existing;
    const start = index * this.pageSize;
    const count = Math.min(this.pageSize, this.rowCount - start);
    this.fetches++;
    const promise = this.fetchPage(start, count)
      .then((table) => {
        if (this.disposed) return;
        this.pages.set(index, table);
        while (this.pages.size > this.maxPages) {
          const oldest = this.pages.keys().next().value as number;
          this.pages.delete(oldest);
        }
        for (const l of this.listeners) l(start, start + count);
      })
      .catch((err: unknown) => {
        this.errors.push(err);
        const message = err instanceof Error ? err.message : String(err);
        for (const l of this.errorListeners) l(message);
      })
      .finally(() => {
        this.inflight.delete(index);
        this.pump();
      });
    this.inflight.set(index, promise);
    return promise;
  }

  /** Sends waiting requests while there is room. */
  private pump(): void {
    while (!this.disposed && this.inflight.size < this.maxInflight && this.queue.length) {
      const next = this.queue.shift()!;
      if (!this.pages.has(next) && !this.inflight.has(next)) void this.request(next);
    }
  }

  private range(start: number, end: number): number[] {
    if (this.rowCount === 0) return [];
    const first = this.pageOf(Math.max(0, start));
    const last = this.pageOf(Math.min(this.rowCount, Math.max(end, start + 1)) - 1);
    const out: number[] = [];
    for (let i = first; i <= last; i++) out.push(i);
    return out;
  }

  /** Pages to load ahead (in the scroll direction) and behind, for this view. */
  private reach(first: number): { ahead: number; behind: number } {
    const at = this.now();
    const last = this.last;
    this.last = { page: first, at };
    if (!last || last.page === first) {
      if (!last || at - last.at > 400) this.direction = 0;
      return this.direction === 0
        ? { ahead: this.prefetchPages, behind: this.prefetchPages }
        : { ahead: this.ahead, behind: Math.min(1, this.prefetchPages) };
    }
    const moved = first - last.page;
    this.direction = Math.sign(moved);
    // Pages per 100 ms: a wheel step is about one page, a fast fling many.
    const speed = (Math.abs(moved) * 100) / Math.max(16, at - last.at);
    // A jump (scrollbar drag, Go to row) is not a direction to read ahead in.
    if (Math.abs(moved) > this.maxAhead * 4) {
      this.direction = 0;
      return { ahead: this.prefetchPages, behind: this.prefetchPages };
    }
    const ahead = Math.min(this.maxAhead, Math.max(this.prefetchPages, Math.ceil(speed)));
    this.ahead = ahead;
    return { ahead, behind: Math.min(1, this.prefetchPages) };
  }

  ensure(start: number, end: number): void {
    const visible = this.range(start, end);
    if (visible.length === 0) return;
    const { ahead, behind } = this.reach(visible[0]!);
    const lastPage = this.pageOf(this.rowCount - 1);
    const down = this.direction >= 0;
    const first = visible[0]!;
    const final = visible[visible.length - 1]!;
    const wanted = [...visible];
    for (let k = 1; k <= Math.max(ahead, behind); k++) {
      const next = down ? final + k : first - k;
      const prev = down ? first - k : final + k;
      if (k <= ahead && next >= 0 && next <= lastPage) wanted.push(next);
      if (k <= behind && prev >= 0 && prev <= lastPage) wanted.push(prev);
    }
    const missing = wanted.filter((i) => !this.pages.has(i) && !this.inflight.has(i));
    // What was waiting for an earlier view and is no longer wanted is dropped.
    const keep = new Set(missing);
    this.dropped += this.queue.filter((i) => !keep.has(i)).length;
    this.queue = missing;
    this.pump();
  }

  async load(start: number, end: number): Promise<void> {
    await Promise.all(this.range(start, end).map((i) => this.request(i)));
  }

  subscribe(listener: (start: number, end: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.listeners.clear();
    this.errorListeners.clear();
    this.pages.clear();
  }
}
