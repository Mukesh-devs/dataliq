import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcBytes, sampleInfo } from "../test/ipc";
import { AUTOSAVE_MS, installErrorReporting, resetSessionForTests, useSession } from "./session";
import { useSettings } from "./settings";
import { useTabs } from "./tabs";

function backend(start: unknown) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    switch (cmd) {
      case "session_start":
        return start;
      case "open_file":
        return { ...sampleInfo, dataset: { id: "ds", rowCount: 3, cached: true } };
      case "preview_file":
        return ipcBytes({ id: [1, 2, 3] });
      default:
        return null;
    }
  });
  return calls;
}

describe("session", () => {
  afterEach(() => {
    clearMocks();
    resetSessionForTests();
    useTabs.setState({ tabs: [], activeId: null });
    useSession.setState({ crashed: false });
    useSettings.setState({ restoreSession: true });
    vi.useRealTimers();
  });

  it("brings the last tabs back and says when the app had crashed", async () => {
    backend({
      unclean: true,
      workspace: { tabs: [{ path: "/data/a.csv", view: { search: "x" } }], active: 0 },
    });
    await useSession.getState().start();
    expect(useSession.getState().crashed).toBe(true);
    expect(useTabs.getState().tabs).toMatchObject([{ path: "/data/a.csv", view: { search: "x" } }]);
  });

  it("starts empty when turned off", async () => {
    useSettings.setState({ restoreSession: false });
    backend({ unclean: false, workspace: { tabs: [{ path: "/data/a.csv" }], active: 0 } });
    await useSession.getState().start();
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("saves a moment after a change, once for a burst, and clears when every tab is closed", async () => {
    const calls = backend({ unclean: false, workspace: null });
    await useSession.getState().start();
    vi.useFakeTimers();
    await useTabs.getState().openPath("/data/a.csv");
    useTabs.getState().setView(useTabs.getState().tabs[0]!.id, { search: "a" });
    useTabs.getState().setView(useTabs.getState().tabs[0]!.id, { search: "ab" });
    expect(calls.filter((c) => c.cmd === "session_save")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    const saves = calls.filter((c) => c.cmd === "session_save");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.args.workspace).toMatchObject({ tabs: [{ path: "/data/a.csv" }] });
    useTabs.getState().close(useTabs.getState().tabs[0]!.id);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(calls.filter((c) => c.cmd === "session_clear")).toHaveLength(1);
  });

  it("keeps program errors in the crash log, not backend answers", () => {
    const calls = backend({ unclean: false, workspace: null });
    const target = new EventTarget() as unknown as Window;
    const stop = installErrorReporting(target);
    const rejection = (reason: unknown) => {
      const e = new Event("unhandledrejection") as PromiseRejectionEvent;
      Object.defineProperty(e, "reason", { value: reason });
      target.dispatchEvent(e);
    };
    rejection({ kind: "cancelled", message: "The query was cancelled." });
    rejection(new TypeError("x is undefined"));
    stop();
    rejection(new Error("after stop"));
    const reports = calls.filter((c) => c.cmd === "report_ui_error");
    expect(reports.map((r) => r.args.message)).toEqual(["TypeError: x is undefined"]);
  });
});
