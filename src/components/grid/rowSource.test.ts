import { tableFromArrays } from "apache-arrow";
import { describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "../../lib/arrow";
import { NOT_LOADED, PagedRowSource, StaticRowSource } from "./rowSource";

const columns: ColumnInfo[] = [{ name: "id", kind: "integer", type: "Int32", nullable: false }];

/** Fake backend: row value = row index. */
function fakeFetch(delay = 0) {
  return vi.fn(async (start: number, count: number) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return tableFromArrays({ id: Int32Array.from({ length: count }, (_, i) => start + i) });
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("StaticRowSource", () => {
  it("serves values straight from the table", () => {
    const s = new StaticRowSource(tableFromArrays({ a: ["x", "y"] }));
    expect(s.rowCount).toBe(2);
    expect(s.columns[0]?.kind).toBe("text");
    expect(s.getValue(1, 0)).toBe("y");
  });
});

describe("PagedRowSource", () => {
  it("loads the visible page plus neighbours and notifies listeners", async () => {
    const fetchPage = fakeFetch();
    const s = new PagedRowSource({ rowCount: 50_000_000, columns, fetchPage, pageSize: 500 });
    const seen: [number, number][] = [];
    s.subscribe((a, b) => seen.push([a, b]));
    expect(s.getValue(1000, 0)).toBe(NOT_LOADED);
    s.ensure(1000, 1040);
    await flush();
    expect(fetchPage.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([500, 1000, 1500]);
    expect(s.getValue(1000, 0)).toBe(1000);
    expect(s.getValue(1499, 0)).toBe(1499);
    expect(seen).toContainEqual([1000, 1500]);
  });

  it("de-duplicates in-flight requests", async () => {
    const fetchPage = fakeFetch(5);
    const s = new PagedRowSource({ rowCount: 10_000, columns, fetchPage, prefetchPages: 0 });
    s.ensure(0, 10);
    s.ensure(0, 10);
    s.ensure(5, 20);
    await s.load(0, 10);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("evicts least recently used pages", async () => {
    const s = new PagedRowSource({
      rowCount: 100_000,
      columns,
      fetchPage: fakeFetch(),
      pageSize: 100,
      maxPages: 3,
      prefetchPages: 0,
    });
    await s.load(0, 100); // page 0
    await s.load(100, 200); // page 1
    s.getValue(0, 0); // touch page 0
    await s.load(200, 300); // page 2
    await s.load(300, 400); // page 3 -> evicts page 1
    expect(s.cachedPages).toBe(3);
    expect(s.isLoaded(0)).toBe(true);
    expect(s.isLoaded(150)).toBe(false);
  });

  it("clamps the last page to the row count", async () => {
    const fetchPage = fakeFetch();
    const s = new PagedRowSource({ rowCount: 1234, columns, fetchPage, pageSize: 500 });
    await s.load(1200, 1234);
    expect(fetchPage).toHaveBeenCalledWith(1000, 234);
    expect(s.getValue(1233, 0)).toBe(1233);
  });

  it("scrolling top to bottom of 50M rows never leaves a visible page unloaded", async () => {
    const fetchPage = fakeFetch();
    const rowCount = 50_000_000;
    const s = new PagedRowSource({ rowCount, columns, fetchPage, pageSize: 500, maxPages: 32 });
    const height = 40;
    // Jump through the file in big strides, as a fast scroll or drag would.
    for (let top = 0; top < rowCount; top += 997_331) {
      s.ensure(top, top + height);
      await s.load(top, top + height);
      expect(s.getValue(top, 0)).toBe(top);
      expect(s.getValue(Math.min(top + height, rowCount) - 1, 0)).toBe(
        Math.min(top + height, rowCount) - 1,
      );
    }
    const last = rowCount - 1;
    await s.load(last - height, rowCount);
    expect(s.getValue(last, 0)).toBe(last);
    expect(s.cachedPages).toBeLessThanOrEqual(32);
    expect(s.errors).toEqual([]);
  });

  it("reports fetch errors to listeners instead of throwing", async () => {
    const s = new PagedRowSource({
      rowCount: 10,
      columns,
      fetchPage: () => Promise.reject(new Error("boom")),
    });
    const messages: string[] = [];
    s.onError((m) => messages.push(m));
    await s.load(0, 10);
    expect(s.errors).toHaveLength(1);
    expect(messages).toEqual(["boom"]);
    expect(s.getValue(0, 0)).toBe(NOT_LOADED);
  });
});

describe("PagedRowSource: prefetch and dropped requests", () => {
  /** A backend whose answers the test releases. */
  function heldFetch() {
    const waiting: { start: number; release: () => void }[] = [];
    const fetchPage = vi.fn(
      (start: number, count: number) =>
        new Promise<ReturnType<typeof tableFromArrays>>((resolve) => {
          waiting.push({
            start,
            release: () =>
              resolve(
                tableFromArrays({ id: Int32Array.from({ length: count }, (_, i) => start + i) }),
              ),
          });
        }),
    );
    return { fetchPage, waiting };
  }

  it("reads further ahead in the direction of a fast scroll", async () => {
    let t = 0;
    const fetchPage = fakeFetch();
    const s = new PagedRowSource({
      rowCount: 1_000_000,
      columns,
      fetchPage,
      pageSize: 100,
      maxInflight: 16,
      now: () => t,
    });
    s.ensure(0, 40);
    await flush();
    // Two pages every 50 ms: fast, downwards.
    for (let top = 200; top <= 1000; top += 200) {
      t += 50;
      s.ensure(top, top + 40);
      await flush();
    }
    const pages = new Set(fetchPage.mock.calls.map((c) => c[0] / 100));
    // Four pages ahead of page 10, one behind.
    for (const p of [10, 11, 12, 13, 14, 9]) expect(pages.has(p)).toBe(true);
    expect(pages.has(15)).toBe(false);
  });

  it("scrolling up reads ahead upwards", async () => {
    let t = 0;
    const fetchPage = fakeFetch();
    const s = new PagedRowSource({
      rowCount: 1_000_000,
      columns,
      fetchPage,
      pageSize: 100,
      maxInflight: 16,
      now: () => t,
    });
    for (const top of [5000, 4800, 4600]) {
      s.ensure(top, top + 40);
      await flush();
      t += 50;
    }
    const pages = new Set(fetchPage.mock.calls.map((c) => c[0] / 100));
    for (const p of [45, 44, 43, 42]) expect(pages.has(p)).toBe(true);
  });

  it("a fast drag drops the pages it left behind before asking for them", async () => {
    const { fetchPage, waiting } = heldFetch();
    const s = new PagedRowSource({
      rowCount: 50_000_000,
      columns,
      fetchPage,
      pageSize: 500,
      maxInflight: 2,
    });
    // Twenty stops on the way down; the backend answers nothing meanwhile.
    for (let i = 0; i < 20; i++) s.ensure(i * 2_000_000, i * 2_000_000 + 40);
    expect(s.pending).toBe(2);
    expect(s.dropped).toBeGreaterThan(0);
    // Answer everything: only the first two and where the drag stopped load.
    while (waiting.length) {
      waiting.shift()!.release();
      await flush();
    }
    const asked = fetchPage.mock.calls.map((c) => c[0]);
    expect(asked.length).toBeLessThanOrEqual(2 + 3);
    expect(s.getValue(38_000_000, 0)).toBe(38_000_000);
  });

  it("copying (load) never waits behind the queue", async () => {
    const fetchPage = fakeFetch();
    const s = new PagedRowSource({ rowCount: 10_000, columns, fetchPage, maxInflight: 1 });
    await s.load(0, 5000);
    expect(s.getValue(4999, 0)).toBe(4999);
  });
});
