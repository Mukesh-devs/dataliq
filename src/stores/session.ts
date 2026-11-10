import { create } from "zustand";
import { plural } from "../lib/format";
import {
  diagnostics,
  reportUiError,
  sessionClear,
  sessionSave,
  sessionStart,
} from "../lib/session";
import { useLayout } from "./layout";
import { useNotice } from "./notice";
import { useSettings } from "./settings";
import { useSql } from "./sql";
import { useTabs } from "./tabs";
import { applyWorkspace, currentWorkspace } from "./workspace";

/** Changes settle this long before the session is saved. */
export const AUTOSAVE_MS = 1000;
/** UI errors kept in the crash log per run (a loop of errors stops there). */
const MAX_REPORTS = 20;

interface SessionState {
  /** The app didn't close normally last time (shown until dismissed). */
  crashed: boolean;
  dismissCrash: () => void;
  /**
   * At startup: brings back the last session's tabs (unless turned off in
   * Settings), then saves the session a moment after every change.
   */
  start: () => Promise<void>;
  /** Copies the diagnostics text to the clipboard. */
  copyDiagnostics: () => Promise<void>;
}

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastSaved = "";

function scheduleSave() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const { workspace } = currentWorkspace();
    const text = JSON.stringify(workspace);
    if (text === lastSaved) return;
    lastSaved = text;
    const save = workspace.tabs.length > 0 ? sessionSave(workspace) : sessionClear();
    // A session that can't be saved is no reason to bother the user mid-work.
    save.catch(() => {
      lastSaved = "";
    });
  }, AUTOSAVE_MS);
}

/** Saves now what a pending autosave would (e.g. before the window closes). */
export function flushSession() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  const { workspace } = currentWorkspace();
  if (JSON.stringify(workspace) !== lastSaved && workspace.tabs.length > 0)
    void sessionSave(workspace).catch(() => {});
}

export const useSession = create<SessionState>()((set) => ({
  crashed: false,
  dismissCrash: () => set({ crashed: false }),
  start: async () => {
    if (started) return;
    started = true;
    const last = await sessionStart().catch(() => null);
    if (last?.unclean) set({ crashed: true });
    const ws = last?.workspace;
    if (ws && ws.tabs.length > 0 && useSettings.getState().restoreSession) {
      // Files opened meanwhile (from the command line) stay open after them.
      const opened = useTabs.getState().tabs.map((t) => t.path);
      const tabs = ws.tabs.filter((t) => !opened.includes(t.path));
      if (tabs.length > 0 && opened.length === 0) {
        await applyWorkspace({ ...ws, tabs });
        useNotice.getState().show(`Reopened ${plural(tabs.length, "file")} from your last session`);
      }
    }
    lastSaved = JSON.stringify(currentWorkspace().workspace);
    useTabs.subscribe(scheduleSave);
    useSql.subscribe(scheduleSave);
    useLayout.subscribe(scheduleSave);
  },
  copyDiagnostics: async () => {
    const notice = useNotice.getState().show;
    try {
      await navigator.clipboard.writeText(await diagnostics());
      notice("Diagnostics copied. Nothing was sent; paste them where you need them.");
    } catch (e) {
      notice(`Couldn't copy the diagnostics: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
}));

let reports = 0;

/** Keeps errors the UI didn't handle in the local crash log (nothing is sent). */
export function installErrorReporting(target: Window = window) {
  const report = (err: unknown) => {
    // Only real program errors: a backend answer ({ kind, message }) is handled where asked.
    if (!(err instanceof Error) || reports >= MAX_REPORTS) return;
    reports++;
    void reportUiError(`${err.name}: ${err.message}`, err.stack).catch(() => {});
  };
  const onError = (e: ErrorEvent) => report(e.error);
  const onRejection = (e: PromiseRejectionEvent) => report(e.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** For tests: forget that the session started. */
export function resetSessionForTests() {
  started = false;
  lastSaved = "";
  reports = 0;
  clearTimeout(timer);
  timer = undefined;
}
