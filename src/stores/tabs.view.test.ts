import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcBytes, sampleInfo } from "../test/ipc";
import type { Filter } from "../lib/view";
import { useTabs } from "./tabs";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const base = { id: "ds1", rowCount: 1000, cached: true };
const nameFilter: Filter = { column: "name", op: "contains", value: "a" };

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** Backend whose import and open_view answers the test controls. */
function backend(opts: {
  importDone: Promise<unknown>;
  openView: (args: Call["args"]) => unknown;
}) {
  const calls: Call[] = [];
  mockIPC(
    (cmd, a) => {
      const args = a as Record<string, unknown>;
      calls.push({ cmd, args });
      switch (cmd) {
        case "open_file":
          return sampleInfo;
        case "preview_file":
          return ipcBytes({ id: [1, 2, 3], name: ["a", "b", null] });
        case "import_file":
          return opts.importDone;
        case "open_view":
          return opts.openView(args);
        case "close_dataset":
        case "cancel_import":
        case "cancel_query":
          return true;
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const tab = () => useTabs.getState().tabs[0]!;

describe("tabs store: views", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));
  afterEach(() => clearMocks());

  it("waits for the import, then opens the view", async () => {
    const job = deferred<unknown>();
    const calls = backend({
      importDone: job.promise,
      openView: () => ({ dataset: { id: "view-1", rowCount: 40 }, totalRows: 1000, elapsedMs: 12 }),
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await useTabs.getState().setView(tab().id, { filters: [nameFilter] });
    expect(tab().view).toEqual({ filters: [nameFilter] });
    expect(tab().viewState?.status).toBe("waiting");
    expect(calls.some((c) => c.cmd === "open_view")).toBe(false);

    job.resolve({ dataset: base, fromCache: false, elapsedMs: 100 });
    await settle();
    await settle();
    const call = calls.find((c) => c.cmd === "open_view")!;
    expect(call.args).toMatchObject({
      datasetId: "ds1",
      spec: { filters: [nameFilter] },
      group: `view:${tab().id}`,
    });
    expect(tab().viewState).toMatchObject({
      status: "done",
      dataset: { id: "view-1", rowCount: 40 },
      totalRows: 1000,
      elapsedMs: 12,
    });
  });

  it("keeps only the newest view and closes replaced ones", async () => {
    const answers = [deferred<unknown>(), deferred<unknown>()];
    let n = 0;
    const calls = backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: () => answers[n++]!.promise,
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    const id = tab().id;
    const first = useTabs.getState().setView(id, { filters: [nameFilter] });
    const second = useTabs
      .getState()
      .setView(id, { filters: [nameFilter, { column: "id", op: "gt", value: 1 }] });
    expect(tab().viewState?.status).toBe("running");
    // The second answer arrives first; the stale first one is closed unused.
    answers[1]!.resolve({ dataset: { id: "view-2", rowCount: 5 }, totalRows: 1000, elapsedMs: 3 });
    await second;
    answers[0]!.resolve({ dataset: { id: "view-1", rowCount: 9 }, totalRows: 1000, elapsedMs: 3 });
    await first;
    expect(tab().viewState?.dataset?.id).toBe("view-2");
    const closed = calls.filter((c) => c.cmd === "close_dataset").map((c) => c.args.datasetId);
    expect(closed).toContain("view-1");

    // Clearing the filters closes the view and goes back to the full data.
    await useTabs.getState().setView(id, { filters: [] });
    expect(tab().view).toBeUndefined();
    expect(tab().viewState).toBeUndefined();
    expect(calls.filter((c) => c.cmd === "close_dataset").map((c) => c.args.datasetId)).toContain(
      "view-2",
    );
  });

  it("shows errors and keeps the last good rows", async () => {
    let fail = false;
    backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: () => {
        if (fail) throw { kind: "query", message: "Invalid regular expression" };
        return { dataset: { id: "view-1", rowCount: 9 }, totalRows: 1000, elapsedMs: 3 };
      },
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    const id = tab().id;
    await useTabs.getState().setView(id, { filters: [nameFilter] });
    fail = true;
    await useTabs
      .getState()
      .setView(id, { filters: [{ column: "name", op: "regex", pattern: "(" }] });
    expect(tab().viewState).toMatchObject({
      status: "error",
      error: "Invalid regular expression",
      dataset: { id: "view-1" },
    });
  });

  it("closing the tab closes its view", async () => {
    const calls = backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: () => ({ dataset: { id: "view-7", rowCount: 1 }, totalRows: 1000, elapsedMs: 1 }),
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    await useTabs.getState().setView(tab().id, { filters: [nameFilter] });
    useTabs.getState().close(tab().id);
    const closed = calls.filter((c) => c.cmd === "close_dataset").map((c) => c.args.datasetId);
    expect(closed).toEqual(expect.arrayContaining(["ds1", "view-7"]));
  });
});

describe("tabs store: cancelling views", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));
  afterEach(() => clearMocks());

  it("clearing the view cancels a sort still running", async () => {
    const pending = deferred<unknown>();
    const calls = backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: () => pending.promise,
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    const id = tab().id;
    void useTabs.getState().setView(id, { sort: [{ column: "id", descending: true }] });
    await settle();
    const requestId = tab().viewState?.requestId;
    expect(tab().viewState?.status).toBe("running");
    await useTabs.getState().setView(id, {});
    expect(calls.find((c) => c.cmd === "cancel_query")?.args).toEqual({ requestId });
    pending.resolve({ dataset: { id: "view-9", rowCount: 1 }, totalRows: 1000, elapsedMs: 1 });
    await settle();
    expect(tab().viewState).toBeUndefined();
  });
});

describe("tabs store: cancel button", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));
  afterEach(() => clearMocks());

  it("cancelling a running view goes back to the rows on screen", async () => {
    const second = deferred<unknown>();
    let n = 0;
    const calls = backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: () =>
        ++n === 1
          ? { dataset: { id: "view-1", rowCount: 10 }, totalRows: 1000, elapsedMs: 5 }
          : second.promise,
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    const id = tab().id;
    await useTabs.getState().setView(id, { filters: [nameFilter] });
    void useTabs.getState().setView(id, {
      filters: [nameFilter],
      sort: [{ column: "id", descending: true }],
    });
    await settle();
    const requestId = tab().viewState?.requestId;
    useTabs.getState().cancelView(id);
    expect(calls.filter((c) => c.cmd === "cancel_query").map((c) => c.args)).toEqual([
      { requestId },
    ]);
    // Filters of the rows on screen, not the cancelled sort.
    expect(tab().view).toEqual({ filters: [nameFilter] });
    expect(tab().viewState).toMatchObject({ status: "done", dataset: { id: "view-1" } });
    // The cancelled request's answer is dropped and its dataset closed.
    second.resolve({ dataset: { id: "view-2", rowCount: 1 }, totalRows: 1000, elapsedMs: 1 });
    await settle();
    expect(tab().viewState?.dataset?.id).toBe("view-1");
    expect(calls.filter((c) => c.cmd === "close_dataset").map((c) => c.args.datasetId)).toContain(
      "view-2",
    );
  });

  it("cancelling the first view shows the whole file again", async () => {
    backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: () => new Promise(() => {}),
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    void useTabs.getState().setView(tab().id, { filters: [nameFilter] });
    await settle();
    useTabs.getState().cancelView(tab().id);
    expect(tab().view).toBeUndefined();
    expect(tab().viewState).toBeUndefined();
  });

  it("stopping a background sort keeps the filters", async () => {
    const specs: unknown[] = [];
    backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: (args) => {
        specs.push(args.spec);
        return {
          dataset: { id: `view-${specs.length}`, rowCount: 10 },
          totalRows: 1000,
          elapsedMs: 5,
          materializing: true,
        };
      },
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    const id = tab().id;
    await useTabs.getState().setView(id, { filters: [nameFilter], sort: [{ column: "id" }] });
    expect(tab().viewState?.sorting).toBe(true);
    useTabs.getState().cancelView(id);
    await settle();
    expect(specs.at(-1)).toEqual({ filters: [nameFilter], sort: [] });
    expect(tab().viewState).toMatchObject({ sorting: false, dataset: { id: "view-2" } });
  });
});

describe("tabs store: background sorts", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));
  afterEach(() => clearMocks());

  it("marks a big sort as still sorting until view-ready", async () => {
    backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: () => ({
        dataset: { id: "view-3", rowCount: 1000 },
        totalRows: 1000,
        elapsedMs: 900,
        materializing: true,
      }),
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    const id = tab().id;
    await useTabs.getState().setView(id, { sort: [{ column: "id" }] });
    expect(tab().viewState).toMatchObject({ status: "done", sorting: true, elapsedMs: 900 });
    // Another view's event changes nothing.
    useTabs.getState().applyViewReady({ datasetId: "view-99", elapsedMs: 1 });
    expect(tab().viewState?.sorting).toBe(true);
    useTabs.getState().applyViewReady({ datasetId: "view-3", elapsedMs: 31_000 });
    expect(tab().viewState).toMatchObject({ sorting: false, fullMs: 31_000 });
  });

  it("filter-only views are never shown as sorting", async () => {
    backend({
      importDone: Promise.resolve({ dataset: base, fromCache: true, elapsedMs: 1 }),
      openView: () => ({
        dataset: { id: "view-4", rowCount: 10 },
        totalRows: 1000,
        elapsedMs: 5,
        materializing: true,
      }),
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    await useTabs.getState().setView(tab().id, { filters: [nameFilter] });
    expect(tab().viewState?.sorting).toBe(false);
  });
});
