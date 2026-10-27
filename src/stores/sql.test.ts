import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcBytes } from "../test/ipc";
import { MAX_RESULT_ROWS, useSql } from "./sql";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

function backend(answer: (sql: string) => unknown) {
  const calls: Call[] = [];
  mockIPC((cmd, a) => {
    const args = a as Record<string, unknown>;
    calls.push({ cmd, args });
    if (cmd === "run_query") return answer(String(args.sql));
    if (cmd === "cancel_query") return true;
    throw new Error(`unexpected ${cmd}`);
  });
  return calls;
}

describe("sql store", () => {
  beforeEach(() =>
    useSql.setState({ running: null, result: undefined, error: undefined, text: "" }),
  );
  afterEach(() => clearMocks());

  it("runs each statement in order and shows the last one's rows", async () => {
    const calls = backend((sql) => ipcBytes({ n: [sql.length] }));
    await useSql.getState().run("CREATE TABLE t AS SELECT 1; SELECT * FROM t");
    expect(calls.map((c) => c.args.sql)).toEqual(["CREATE TABLE t AS SELECT 1", "SELECT * FROM t"]);
    const { result, running } = useSql.getState();
    expect(running).toBeNull();
    expect(result).toMatchObject({ statement: "SELECT * FROM t", count: 2, truncated: false });
    expect(result?.table.numRows).toBe(1);
  });

  it("shows at most MAX_RESULT_ROWS rows and says there are more", async () => {
    backend(() => ipcBytes({ n: Array.from({ length: MAX_RESULT_ROWS + 1 }, (_, i) => i) }));
    await useSql.getState().run("SELECT * FROM range(20000)");
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
    const requestId = (calls[0]?.args.options as { requestId: string }).requestId;
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
