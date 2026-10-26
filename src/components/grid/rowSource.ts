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
  /** Extra pages loaded before and after the visible range. */
  prefetchPages?: number;
}

/**
 * Pages rows from the backend with an LRU of pages and prefetching around
 * the visible range. Requests for the same page are de-duplicated.
 */
export class PagedRowSource implements RowSource {
  readonly rowCount: number;
  readonly columns: ColumnInfo[];
  readonly pageSize: number;
  private readonly maxPages: number;
  private readonly prefetchPages: number;
  private readonly fetchPage: FetchPage;
  /** Insertion order = recency (Map keeps insertion order). */
  private readonly pages = new Map<number, Table>();
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly listeners = new Set<(start: number, end: number) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  private disposed = false;
  /** Number of fetches issued, for tests and diagnostics. */
  fetches = 0;
  errors: unknown[] = [];

  constructor(opts: PagedOptions) {
    this.rowCount = opts.rowCount;
    this.columns = opts.columns;
    this.fetchPage = opts.fetchPage;
    this.pageSize = opts.pageSize ?? 500;
    this.maxPages = opts.maxPages ?? 64;
    this.prefetchPages = opts.prefetchPages ?? 1;
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
      .finally(() => this.inflight.delete(index));
    this.inflight.set(index, promise);
    return promise;
  }

  private range(start: number, end: number): number[] {
    if (this.rowCount === 0) return [];
    const first = this.pageOf(Math.max(0, start));
    const last = this.pageOf(Math.min(this.rowCount, Math.max(end, start + 1)) - 1);
    const out: number[] = [];
    for (let i = first; i <= last; i++) out.push(i);
    return out;
  }

  ensure(start: number, end: number): void {
    const visible = this.range(start, end);
    if (visible.length === 0) return;
    // Visible pages first, then neighbours.
    for (const i of visible) void this.request(i);
    const lastPage = this.pageOf(this.rowCount - 1);
    for (let k = 1; k <= this.prefetchPages; k++) {
      const after = visible[visible.length - 1]! + k;
      const before = visible[0]! - k;
      if (after <= lastPage) void this.request(after);
      if (before >= 0) void this.request(before);
    }
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
    this.listeners.clear();
    this.errorListeners.clear();
    this.pages.clear();
  }
}
