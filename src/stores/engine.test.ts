import { tableFromArrays, tableToIPC } from "apache-arrow";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { useEngine } from "./engine";

describe("engine store", () => {
  afterEach(() => {
    clearMocks();
    useEngine.setState({ version: null, error: null });
  });

  it("reads the DuckDB version through the Arrow IPC path", async () => {
    mockIPC((cmd, args) => {
      expect(cmd).toBe("run_query");
      expect(args).toMatchObject({ sql: "SELECT version() AS v" });
      return tableToIPC(tableFromArrays({ v: ["v1.5.6"] }), "stream").buffer;
    });
    await useEngine.getState().probe();
    expect(useEngine.getState().version).toBe("v1.5.6");
  });

  it("keeps a plain error message when the backend fails", async () => {
    mockIPC(() => {
      throw { kind: "query", message: "Catalog Error: nope" };
    });
    await useEngine.getState().probe();
    expect(useEngine.getState()).toMatchObject({ version: null, error: "Catalog Error: nope" });
  });
});
