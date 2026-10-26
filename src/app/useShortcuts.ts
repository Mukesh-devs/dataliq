import { useEffect } from "react";
import { isMac } from "../lib/platform";

export interface ShortcutHandlers {
  openFile: () => void;
  closeTab: () => void;
  nextTab: () => void;
  previousTab: () => void;
}

/**
 * App-wide keyboard shortcuts. Mod = Cmd on macOS, Ctrl elsewhere; tab
 * switching uses Ctrl+Tab everywhere (as browsers and editors do).
 */
export function useShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === "tab") {
        e.preventDefault();
        if (e.shiftKey) handlers.previousTab();
        else handlers.nextTab();
      } else if (mod && !e.shiftKey && key === "o") {
        e.preventDefault();
        handlers.openFile();
      } else if (mod && !e.shiftKey && key === "w") {
        e.preventDefault();
        handlers.closeTab();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}
