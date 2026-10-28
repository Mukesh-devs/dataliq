import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  updateStatus: vi.fn(),
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  onUpdateProgress: vi.fn(),
}));
vi.mock("../lib/update", async (orig) => ({
  ...(await orig<typeof import("../lib/update")>()),
  ...api,
}));

import { useUpdate } from "./update";

const info = { version: "1.1.0", currentVersion: "1.0.0", date: null, notes: "Faster." };

describe("update store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    useUpdate.setState({ phase: "idle", info: null, open: false, error: null, progress: null });
    api.updateStatus.mockResolvedValue({ configured: true, currentVersion: "1.0.0" });
    api.onUpdateProgress.mockResolvedValue(() => {});
  });

  it("says when the build can't update itself", async () => {
    api.updateStatus.mockResolvedValue({ configured: false, currentVersion: "1.0.0" });
    await useUpdate.getState().check();
    expect(useUpdate.getState()).toMatchObject({ phase: "unavailable", open: true });
    expect(api.checkUpdate).not.toHaveBeenCalled();
  });

  it("finds a newer version, or says this is the latest", async () => {
    api.checkUpdate.mockResolvedValueOnce(info);
    await useUpdate.getState().check();
    expect(useUpdate.getState()).toMatchObject({ phase: "available", info, open: true });

    api.checkUpdate.mockResolvedValueOnce(null);
    await useUpdate.getState().check();
    expect(useUpdate.getState()).toMatchObject({ phase: "latest", currentVersion: "1.0.0" });
  });

  it("shows a failed check in words", async () => {
    api.checkUpdate.mockRejectedValue(new Error("Couldn't check for updates: offline"));
    await useUpdate.getState().check();
    expect(useUpdate.getState()).toMatchObject({
      phase: "error",
      error: "Couldn't check for updates: offline",
    });
  });

  it("checks quietly at startup, at most once a day, and opens only for a new version", async () => {
    api.checkUpdate.mockResolvedValue(null);
    await useUpdate.getState().autoCheck();
    expect(api.checkUpdate).toHaveBeenCalledTimes(1);
    expect(useUpdate.getState()).toMatchObject({ phase: "idle", open: false });

    // Checked less than a day ago: not again.
    await useUpdate.getState().autoCheck();
    expect(api.checkUpdate).toHaveBeenCalledTimes(1);

    localStorage.setItem("dataliq.lastUpdateCheck", String(Date.now() - 25 * 3600 * 1000));
    api.checkUpdate.mockResolvedValue(info);
    await useUpdate.getState().autoCheck();
    expect(useUpdate.getState()).toMatchObject({ phase: "available", info, open: true });
  });

  it("stays silent at startup when offline or not set up", async () => {
    api.checkUpdate.mockRejectedValue(new Error("offline"));
    await useUpdate.getState().autoCheck();
    expect(useUpdate.getState()).toMatchObject({ phase: "idle", open: false });

    localStorage.clear();
    api.updateStatus.mockResolvedValue({ configured: false, currentVersion: "1.0.0" });
    await useUpdate.getState().autoCheck();
    expect(useUpdate.getState().open).toBe(false);
  });

  it("installs with progress, and reports a failed install", async () => {
    let report: (p: { downloaded: number; total: number | null }) => void = () => {};
    const unlisten = vi.fn();
    api.onUpdateProgress.mockImplementation(async (h) => {
      report = h;
      return unlisten;
    });
    api.installUpdate.mockImplementation(async () => {
      report({ downloaded: 5, total: 10 });
      expect(useUpdate.getState()).toMatchObject({
        phase: "installing",
        progress: { downloaded: 5, total: 10 },
      });
      throw new Error("Couldn't install the update: signature mismatch");
    });
    await useUpdate.getState().install();
    expect(useUpdate.getState()).toMatchObject({
      phase: "error",
      error: "Couldn't install the update: signature mismatch",
    });
    expect(unlisten).toHaveBeenCalled();
  });
});
