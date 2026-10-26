import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcBytes, sampleInfo } from "../test/ipc";
import { useTabs } from "./tabs";

describe("tabs store: opening files", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));
  afterEach(() => clearMocks());

  it("opens a file: info + preview in one go", async () => {
    const calls: string[] = [];
    mockIPC((cmd, args) => {
      calls.push(cmd);
      expect(args).toMatchObject({ path: "/data/sales.csv.gz" });
      if (cmd === "open_file") return sampleInfo;
      if (cmd === "preview_file") return ipcBytes({ id: [1, 2, 3], name: ["a", "b", null] });
      throw new Error(`unexpected ${cmd}`);
    });
    await useTabs.getState().openPath("/data/sales.csv.gz");
    const [tab] = useTabs.getState().tabs;
    expect(calls.sort()).toEqual(["open_file", "preview_file"]);
    expect(tab).toMatchObject({ title: "sales.csv.gz", status: "ready" });
    expect(tab?.preview?.numRows).toBe(3);
    expect(tab?.previewMs).toBeGreaterThanOrEqual(0);
    expect(useTabs.getState().activeId).toBe(tab?.id);
  });

  it("keeps the plain error message on failure", async () => {
    mockIPC(() => {
      throw { kind: "query", message: "Row 3 has 4 columns, expected 3." };
    });
    await useTabs.getState().openPath("C:\\data\\bad.csv");
    const [tab] = useTabs.getState().tabs;
    expect(tab).toMatchObject({ title: "bad.csv", status: "error" });
    expect(tab?.error).toBe("Row 3 has 4 columns, expected 3.");
  });

  it("re-opens with new import settings", async () => {
    const seen: unknown[] = [];
    mockIPC((cmd, args) => {
      seen.push((args as { options: unknown }).options);
      return cmd === "open_file" ? sampleInfo : ipcBytes({ id: [1] });
    });
    await useTabs.getState().openPath("/d/a.csv");
    const id = useTabs.getState().tabs[0]!.id;
    await useTabs.getState().reopen(id, { csv: { delimiter: ";", ignoreErrors: true } });
    expect(seen.at(-1)).toEqual({ csv: { delimiter: ";", ignoreErrors: true } });
    expect(useTabs.getState().tabs[0]?.options).toEqual({
      csv: { delimiter: ";", ignoreErrors: true },
    });
  });

  it("focuses an already open file instead of opening it twice", async () => {
    mockIPC((cmd) => (cmd === "open_file" ? sampleInfo : ipcBytes({ id: [1] })));
    await useTabs.getState().openPath("/d/a.csv");
    await useTabs.getState().openPath("/d/b.csv");
    await useTabs.getState().openPath("/d/a.csv");
    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(2);
    expect(activeId).toBe(tabs[0]?.id);
  });
});
