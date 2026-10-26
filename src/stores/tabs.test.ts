import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcBytes, sampleInfo } from "../test/ipc";
import { useTabs } from "./tabs";

const dataset = { id: "ds1", rowCount: 109_000_000, cached: true };

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

/** Default backend: open + preview succeed; `import_file` is controllable. */
function mockBackend(importResult: () => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd in extra) {
        const v = extra[cmd];
        return typeof v === "function" ? (v as () => unknown)() : v;
      }
      switch (cmd) {
        case "open_file":
          return sampleInfo;
        case "preview_file":
          return ipcBytes({ id: [1, 2, 3], name: ["a", "b", null] });
        case "import_file":
          return importResult();
        case "cancel_import":
        case "close_dataset":
          return true;
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
  return calls;
}

describe("tabs store: opening files", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));
  afterEach(() => clearMocks());

  it("shows the preview first, then switches to the imported dataset", async () => {
    const job = deferred<unknown>();
    const calls = mockBackend(() => job.promise);
    await useTabs.getState().openPath("/data/sales.csv.gz");
    let [tab] = useTabs.getState().tabs;
    expect(tab).toMatchObject({ title: "sales.csv.gz", status: "ready" });
    expect(tab?.preview?.numRows).toBe(3);
    expect(tab?.import?.status).toBe("running");
    expect(calls.map((c) => c.cmd)).toEqual(
      expect.arrayContaining(["open_file", "preview_file", "import_file"]),
    );
    job.resolve({ dataset, fromCache: false, elapsedMs: 4200 });
    await settle();
    [tab] = useTabs.getState().tabs;
    expect(tab?.info?.dataset).toEqual(dataset);
    expect(tab?.import).toMatchObject({ status: "done", elapsedMs: 4200, fromCache: false });
  });

  it("applies progress events to the matching import", async () => {
    const job = deferred<unknown>();
    const calls = mockBackend(() => job.promise);
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    const jobId = calls.find((c) => c.cmd === "import_file")?.args.jobId;
    const { applyProgress } = useTabs.getState();
    applyProgress({ jobId: String(jobId), percent: 42.5, elapsedMs: 1500 });
    applyProgress({ jobId: "someone-else", percent: 99, elapsedMs: 1 });
    expect(useTabs.getState().tabs[0]?.import).toMatchObject({ percent: 42.5, elapsedMs: 1500 });
    job.resolve({ dataset, fromCache: false, elapsedMs: 2000 });
  });

  it("cancelling keeps the preview and marks the import cancelled", async () => {
    const job = deferred<unknown>();
    const calls = mockBackend(() => job.promise);
    await useTabs.getState().openPath("/d/a.csv");
    const id = useTabs.getState().tabs[0]!.id;
    await useTabs.getState().cancelImport(id);
    expect(calls.some((c) => c.cmd === "cancel_import")).toBe(true);
    job.reject({ kind: "cancelled", message: "The query was cancelled." });
    await settle();
    const tab = useTabs.getState().tabs[0];
    expect(tab?.import?.status).toBe("cancelled");
    expect(tab?.preview?.numRows).toBe(3);
    expect(tab?.info?.dataset).toBeNull();
  });

  it("offers reading directly when disk space is low", async () => {
    mockBackend(
      () => Promise.reject({ kind: "low-disk", message: "Not enough free disk space." }),
      {
        open_direct: { id: "direct-1", rowCount: 5000, cached: false },
      },
    );
    await useTabs.getState().openPath("/d/a.csv");
    await settle();
    const id = useTabs.getState().tabs[0]!.id;
    expect(useTabs.getState().tabs[0]?.import).toMatchObject({
      status: "error",
      errorKind: "low-disk",
    });
    await useTabs.getState().readDirect(id);
    expect(useTabs.getState().tabs[0]?.info?.dataset).toMatchObject({
      id: "direct-1",
      cached: false,
    });
  });

  it("keeps the plain error message when opening fails", async () => {
    mockIPC(() => {
      throw { kind: "query", message: "Line 7 has 4 columns, expected 3." };
    });
    await useTabs.getState().openPath("C:\\data\\bad.csv");
    const [tab] = useTabs.getState().tabs;
    expect(tab).toMatchObject({ title: "bad.csv", status: "error" });
    expect(tab?.error).toBe("Line 7 has 4 columns, expected 3.");
  });

  it("re-opens with new import settings and re-imports", async () => {
    const calls = mockBackend(() => Promise.resolve({ dataset, fromCache: false, elapsedMs: 1 }));
    await useTabs.getState().openPath("/d/a.csv");
    await settle();
    const id = useTabs.getState().tabs[0]!.id;
    await useTabs.getState().reopen(id, { csv: { delimiter: ";", ignoreErrors: true } });
    await settle();
    expect(calls.filter((c) => c.cmd === "close_dataset")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "import_file").at(-1)?.args.options).toEqual({
      csv: { delimiter: ";", ignoreErrors: true },
    });
  });

  it("closing a tab cancels its import and closes its dataset", async () => {
    const calls = mockBackend(() => Promise.resolve({ dataset, fromCache: true, elapsedMs: 5 }));
    await useTabs.getState().openPath("/d/a.csv");
    await settle();
    useTabs.getState().close(useTabs.getState().tabs[0]!.id);
    expect(useTabs.getState().tabs).toHaveLength(0);
    expect(calls.some((c) => c.cmd === "close_dataset" && c.args.datasetId === "ds1")).toBe(true);
  });

  it("focuses an already open file instead of opening it twice", async () => {
    mockBackend(() => Promise.resolve({ dataset, fromCache: true, elapsedMs: 1 }));
    await useTabs.getState().openPath("/d/a.csv");
    await useTabs.getState().openPath("/d/b.csv");
    await useTabs.getState().openPath("/d/a.csv");
    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(2);
    expect(activeId).toBe(tabs[0]?.id);
  });
});
