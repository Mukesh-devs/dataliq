import { create } from "zustand";
import { cancelQuery } from "../lib/ipc";

/** A long query a tool started (a pivot, a join, a summary, a structure…). */
export interface Job {
  id: number;
  /** What it does, e.g. "Grouping sales.csv by city". */
  title: string;
  /** The engine request to cancel. */
  requestId: string;
  /** `performance.now()` when it started. */
  startedAt: number;
}

interface JobsState {
  jobs: Job[];
  /** Registers a running query; returns its id for `finish`. */
  start: (title: string, requestId: string) => number;
  finish: (id: number) => void;
  /** Stops the query (it then fails as cancelled) and forgets it. */
  cancel: (id: number) => void;
  /** Stops every query started at or after `since` (a dialog's Run). */
  cancelSince: (since: number) => void;
}

let nextJob = 1;
let nextRequest = 1;

/** A request id for a tool query (the engine cancels by it). */
export const toolRequestId = (kind: string) => `${kind}-${nextRequest++}`;

export const useJobs = create<JobsState>()((set, get) => ({
  jobs: [],
  start: (title, requestId) => {
    const id = nextJob++;
    set((s) => ({ jobs: [...s.jobs, { id, title, requestId, startedAt: performance.now() }] }));
    return id;
  },
  finish: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
  cancel: (id) => {
    const job = get().jobs.find((j) => j.id === id);
    if (job) void cancelQuery(job.requestId).catch(() => {});
    get().finish(id);
  },
  cancelSince: (since) => {
    for (const j of get().jobs) if (j.startedAt >= since) get().cancel(j.id);
  },
}));

/**
 * Runs `work` (which sends its query as `requestId`) as a job the status
 * bar shows with a timer and a Stop button.
 */
export async function asJob<T>(
  title: string,
  requestId: string,
  work: () => Promise<T>,
): Promise<T> {
  const id = useJobs.getState().start(title, requestId);
  try {
    return await work();
  } finally {
    useJobs.getState().finish(id);
  }
}

/** "0.4 s", "12 s", "3 min 05 s". */
export function formatElapsed(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}
