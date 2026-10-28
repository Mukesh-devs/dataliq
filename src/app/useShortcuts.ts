import { useEffect } from "react";
import { isMac } from "../lib/platform";

export interface ShortcutHandlers {
  openFile: () => void;
  /** Shift+Ctrl+O: a folder (or pattern) of files as one table. */
  openFolder: () => void;
  closeTab: () => void;
  nextTab: () => void;
  previousTab: () => void;
  /** Ctrl+K. */
  commandPalette: () => void;
  /** Shift+Ctrl+C: the "copy as" choices. */
  copyAs: () => void;
  /** Ctrl+J. */
  toggleSql: () => void;
  saveWorkspace: () => void;
  saveWorkspaceAs: () => void;
  /** Ctrl+B: left sidebar; Ctrl+Alt+B: right panel (column profile). */
  toggleSidebar: () => void;
  toggleProfile: () => void;
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
      } else if (mod && e.shiftKey && key === "o") {
        e.preventDefault();
        handlers.openFolder();
      } else if (mod && !e.shiftKey && key === "w") {
        e.preventDefault();
        handlers.closeTab();
      } else if (mod && e.shiftKey && key === "c") {
        e.preventDefault();
        handlers.copyAs();
      } else if (mod && !e.shiftKey && key === "b") {
        e.preventDefault();
        if (e.altKey) handlers.toggleProfile();
        else handlers.toggleSidebar();
      } else if (mod && key === "s") {
        e.preventDefault();
        if (e.shiftKey) handlers.saveWorkspaceAs();
        else handlers.saveWorkspace();
      } else if (mod && !e.shiftKey && key === "j") {
        e.preventDefault();
        handlers.toggleSql();
      } else if (mod && !e.shiftKey && key === "k") {
        e.preventDefault();
        handlers.commandPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}
