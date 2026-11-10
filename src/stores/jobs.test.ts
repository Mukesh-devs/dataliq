import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { asJob, formatElapsed, toolRequestId, useJobs } from "./jobs";

describe("jobs", () => {
  afterEach(() => {
    clearMocks();
    useJobs.setState({ jobs: [] });
  });

  it("shows a query while it runs and forgets it after, even when it fails", async () => {
    let release!: () => void;
    const running = asJob(
      "Grouping a.csv by city",
      "tool-1",
      () => new Promise<void>((r) => (release = r)),
    );
    expect(useJobs.getState().jobs).toMatchObject([
      { title: "Grouping a.csv by city", requestId: "tool-1" },
    ]);
    release();
    await running;
    expect(useJobs.getState().jobs).toEqual([]);
    await expect(asJob("x", "tool-2", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(useJobs.getState().jobs).toEqual([]);
  });

  it("Stop cancels the engine request", () => {
    const cancelled: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "cancel_query") cancelled.push((args as { requestId: string }).requestId);
      return true;
    });
    const a = useJobs.getState().start("a", "tool-a");
    useJobs.getState().start("b", "tool-b");
    useJobs.getState().cancel(a);
    expect(cancelled).toEqual(["tool-a"]);
    expect(useJobs.getState().jobs.map((j) => j.title)).toEqual(["b"]);
    useJobs.getState().cancelSince(0);
    expect(cancelled).toEqual(["tool-a", "tool-b"]);
  });

  it("request ids are unique and times read plainly", () => {
    expect(toolRequestId("tool")).not.toBe(toolRequestId("tool"));
    expect(formatElapsed(400)).toBe("0.4 s");
    expect(formatElapsed(12_300)).toBe("12 s");
    expect(formatElapsed(185_000)).toBe("3 min 05 s");
  });
});
