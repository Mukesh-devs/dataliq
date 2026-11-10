import { call } from "./ipc";
import type { WorkspaceFile } from "./workspace";

/** Mirrors `SessionStart` in src-tauri/src/session.rs. */
export interface SessionStart {
  /** The tabs open when the app last ran. */
  workspace: WorkspaceFile | null;
  /** The app didn't close normally last time. */
  unclean: boolean;
}

/** What the last session left (only the first call gets it). */
export function sessionStart(): Promise<SessionStart> {
  return call("session_start");
}

export function sessionSave(workspace: WorkspaceFile): Promise<void> {
  return call("session_save", { workspace });
}

export function sessionClear(): Promise<void> {
  return call("session_clear");
}

/** Keeps a UI error in the local crash log. */
export function reportUiError(message: string, stack?: string): Promise<void> {
  return call("report_ui_error", { message, stack });
}

/** Versions, system, settings, the last crashes and the end of the log, as text. */
export function diagnostics(): Promise<string> {
  return call("diagnostics");
}
