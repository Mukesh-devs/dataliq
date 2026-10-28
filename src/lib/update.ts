import { call } from "./ipc";

export interface UpdateStatus {
  /** The build can update itself (it has an update key). */
  configured: boolean;
  currentVersion: string;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export function updateStatus(): Promise<UpdateStatus> {
  return call<UpdateStatus>("update_status");
}

/** A newer version, or null when this is the latest. */
export function checkUpdate(): Promise<UpdateInfo | null> {
  return call<UpdateInfo | null>("check_update");
}

/** Downloads, verifies and installs the update found by `checkUpdate`, then restarts. */
export function installUpdate(): Promise<void> {
  return call("install_update");
}

export async function onUpdateProgress(
  handler: (progress: UpdateProgress) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<UpdateProgress>("update-progress", (e) => handler(e.payload));
}

/** Startup checks are at most this often (on by default, see Settings). */
export const AUTO_CHECK_MS = 24 * 60 * 60 * 1000;
