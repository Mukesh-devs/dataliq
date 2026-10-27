import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcBytes } from "../test/ipc";
import { MAX_RESULT_ROWS, useSql } from "./sql";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

let nextDataset = 1;

/** `answer` gives a statement's rows (or throws); queries become datasets. */
function backend(answer: (sql: string) => unknown) {
  const calls: Call[] = [];
  mockIPC(async (cmd, a) => {
    const args = a as Record<string, unknown>;
    calls.push({ cmd, args });
    if (cmd === "run_query") return answer(String(args.sql));
    if (cmd === "sql_result") {
      await answer(String(args.sql));
      return { id: `sql-${nextDataset++}`, rowCount: 1234 };
    }
    if (cmd === "fetch_rows") return ipcBytes({ n: [1, 2, 3] });
    if (cmd === "cancel_query" || cmd === "close_dataset") return true;
    throw new Error(`unexpected ${cmd}`);
  });
  return calls;
}

describe("sql store", () => {
  beforeEach(() =>
    useSql.setState({ running: null, result: undefined, error: undefined, text: "" }),
  );
  afterEach(() => clearMocks());

  it("runs each statement in order; a final query becomes a dataset", async () => {
    const calls = backend((sql) => ipcBytes({ n: [sql.length] }));
    await useSql.getState().run("CREATE TABLE t AS SELECT 1; SELECT * FROM t");
    expect(calls.map((c) => [c.cmd, c.args.sql ?? c.args.datasetId])).toEqual([
      ["run_query", "CREATE TABLE t AS SELECT 1"],
      ["sql_result", "SELECT * FROM t"],
      ["fetch_rows", expect.stringMatching(/^sql-/)],
    ]);
    // Earlier statements' rows aren't shown, so only one is fetched.
    expect((calls[0]!.args.options as { maxRows: number }).maxRows).toBe(1);
    const { result, running } = useSql.getState();
    expect(running).toBeNull();
    expect(result).toMatchObject({
      statement: "SELECT * FROM t",
      count: 2,
      truncated: false,
      dataset: { rowCount: 1234 },
    });
    expect(result?.table.numRows).toBe(3);
  });

  it("closes the previous result's dataset unless it was opened in a tab", async () => {
    const calls = backend(() => ipcBytes({ n: [1] }));
    await useSql.getState().run("SELECT 1");
    const first = useSql.getState().result!.dataset!.id;
    await useSql.getState().run("SELECT 2");
    expect(calls).toContainEqual({ cmd: "close_dataset", args: { datasetId: first } });
    const second = useSql.getState().result!.dataset!.id;
    useSql.getState().markOwned();
    await useSql.getState().run("SELECT 3");
    expect(calls).not.toContainEqual({ cmd: "close_dataset", args: { datasetId: second } });
  });

  it("shows other statements' rows, at most MAX_RESULT_ROWS", async () => {
    backend(() => ipcBytes({ n: Array.from({ length: MAX_RESULT_ROWS + 1 }, (_, i) => i) }));
    await useSql.getState().run("PRAGMA show_tables");
    const result = useSql.getState().result!;
    expect(result.truncated).toBe(true);
    expect(result.table.numRows).toBe(MAX_RESULT_ROWS);
  });

  it("stops at the first error and places it in the editor text", async () => {
    const calls = backend((sql) => {
      if (sql.includes("nope"))
        throw {
          kind: "query",
          message: 'Binder Error: column "nope" not found\n\nLINE 1: SELECT nope\n               ^',
        };
      return ipcBytes({ n: [1] });
    });
    // As a selection starting at offset 100 of the editor text.
    const script = "SELECT 1;\n  SELECT nope;\nSELECT 3";
    await useSql.getState().run(script, 100);
    expect(calls).toHaveLength(2);
    expect(useSql.getState().error).toEqual({
      message: 'Binder Error: column "nope" not found',
      offset: 100 + script.indexOf("nope"),
    });
  });

  it("cancel stops the run and ignores its answer", async () => {
    let answer!: (v: unknown) => void;
    const calls = backend(() => new Promise((r) => (answer = r)));
    const done = useSql.getState().run("SELECT 1");
    await Promise.resolve();
    const requestId = calls[0]?.args.requestId;
    useSql.getState().cancel();
    expect(calls.at(-1)).toEqual({ cmd: "cancel_query", args: { requestId } });
    answer(ipcBytes({ n: [1] }));
    await done;
    expect(useSql.getState().result).toBeUndefined();
    expect(useSql.getState().error?.message).toBe("The query was cancelled.");
  });

  it("does nothing for an empty script", async () => {
    const calls = backend(() => ipcBytes({ n: [1] }));
    await useSql.getState().run("  -- nothing\n");
    expect(calls).toEqual([]);
  });
});
