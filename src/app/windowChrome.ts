import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { isMac } from "../lib/platform";
import { useSettings } from "../stores/settings";

/** Running in the app's own window (not in a plain browser or a unit test). */
export function inAppWindow(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Whether DataLiq draws its own title bar: one row with the menus, search and
 * window buttons, and no system title bar above it. Follows the Title bar
 * setting and turns the system's bar off or on to match. macOS keeps its own.
 */
export function useOwnTitleBar(): boolean {
  const style = useSettings((s) => s.titleBar);
  const own = !isMac && style === "custom";
  useEffect(() => {
    if (isMac || !inAppWindow()) return;
    const win = getCurrentWindow();
    // Only when it differs: the Windows build starts without the system's bar.
    void win
      .isDecorated()
      .then((decorated) => (decorated === own ? win.setDecorations(!own) : undefined))
      .catch(() => {});
  }, [own]);
  return own;
}

/**
 * The window's name follows the tab in front ("orders.csv — DataLiq"), so
 * the taskbar, Alt+Tab and the window list say which file is open.
 */
export function useWindowTitle(name: string | undefined): void {
  useEffect(() => {
    if (!inAppWindow()) return;
    void getCurrentWindow()
      .setTitle(name ? `${name} — DataLiq` : "DataLiq")
      .catch(() => {});
  }, [name]);
}
