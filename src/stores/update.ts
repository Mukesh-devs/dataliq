import { create } from "zustand";
import {
  AUTO_CHECK_MS,
  checkUpdate,
  installUpdate,
  onUpdateProgress,
  updateStatus,
  type UpdateInfo,
  type UpdateProgress,
} from "../lib/update";

export type UpdatePhase =
  "idle" | "checking" | "latest" | "available" | "installing" | "error" | "unavailable";

interface UpdateState {
  phase: UpdatePhase;
  /** The newer version, once found. */
  info: UpdateInfo | null;
  currentVersion: string | null;
  progress: UpdateProgress | null;
  error: string | null;
  /** The update dialog is open. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Help › Check for updates: checks and shows the answer in the dialog. */
  check: () => Promise<void>;
  /**
   * At startup: checks quietly (when the build can update, at most once a
   * day) and opens the dialog only if there is a newer version.
   */
  autoCheck: () => Promise<void>;
  install: () => Promise<void>;
}

const LAST_CHECK_KEY = "dataliq.lastUpdateCheck";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function lastCheck(): number {
  try {
    return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
}

function rememberCheck() {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // Not remembered: the next start checks again.
  }
}

export const useUpdate = create<UpdateState>()((set, get) => ({
  phase: "idle",
  info: null,
  currentVersion: null,
  progress: null,
  error: null,
  open: false,
  setOpen: (open) => set({ open }),
  check: async () => {
    if (get().phase === "installing") return set({ open: true });
    set({ open: true, phase: "checking", error: null });
    try {
      const status = await updateStatus();
      set({ currentVersion: status.currentVersion });
      if (!status.configured) return set({ phase: "unavailable" });
      const info = await checkUpdate();
      rememberCheck();
      set({ info, phase: info ? "available" : "latest" });
    } catch (err) {
      set({ phase: "error", error: messageOf(err) });
    }
  },
  autoCheck: async () => {
    if (Date.now() - lastCheck() < AUTO_CHECK_MS) return;
    try {
      const status = await updateStatus();
      if (!status.configured) return;
      const info = await checkUpdate();
      rememberCheck();
      if (info && get().phase === "idle")
        set({ info, currentVersion: status.currentVersion, phase: "available", open: true });
    } catch {
      // Offline or the release server is down: try again next start.
    }
  },
  install: async () => {
    set({ phase: "installing", progress: null, error: null });
    const unlisten = await onUpdateProgress((progress) => set({ progress }));
    try {
      // Restarts the app when it's done.
      await installUpdate();
    } catch (err) {
      set({ phase: "error", error: messageOf(err) });
    } finally {
      unlisten();
    }
  },
}));
