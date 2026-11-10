import { useEffect } from "react";
import { onSourceChanged, sameVersion, sourceStamps, type SourceStamp } from "../lib/files";
import { useTabs, type Tab } from "../stores/tabs";

/** How often open files are checked while the window is visible. */
export const WATCH_MS = 4000;

/** The version a tab is showing: what it read, or a change the user chose to ignore. */
function shownVersion(tab: Tab): SourceStamp | null | undefined {
  return tab.ignoredStamp ?? tab.info?.stamp;
}

/** Compares the open files with their versions on disk; marks tabs whose file changed. */
export async function checkOpenFiles(): Promise<void> {
  const tabs = useTabs
    .getState()
    .tabs.filter((t) => t.status === "ready" && t.path && shownVersion(t) && !t.onDisk);
  const paths = [...new Set(tabs.map((t) => t.path))];
  if (paths.length === 0) return;
  const now = await sourceStamps(paths).catch(() => null);
  if (!now) return;
  const { markOnDisk } = useTabs.getState();
  paths.forEach((path, i) => {
    const current = now[i] ?? null;
    for (const tab of tabs.filter((t) => t.path === path)) {
      const shown = shownVersion(tab)!;
      if (!current) markOnDisk(path, null, true);
      else if (!sameVersion(shown, current)) markOnDisk(path, current);
    }
  });
}

/**
 * Notices when an open file changes on disk: checked every few seconds
 * while the window is visible, and when it gets focus again; the backend
 * also says when a file reopened from the cache turns out to differ.
 */
export function useFileWatch() {
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible") void checkOpenFiles();
    };
    const timer = setInterval(check, WATCH_MS);
    window.addEventListener("focus", check);
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onSourceChanged((path) => {
      const stamp = useTabs.getState().tabs.find((t) => t.path === path)?.info?.stamp ?? null;
      useTabs.getState().markOnDisk(path, stamp);
    })
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
      unlisten?.();
    };
  }, []);
}
