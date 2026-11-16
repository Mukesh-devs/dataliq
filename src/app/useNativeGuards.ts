import { useEffect } from "react";
import { isMac } from "../lib/platform";

type Keys = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/**
 * Whether a key press is one of the web view's own browser shortcuts, which
 * make no sense in a desktop app: reload (F5, Ctrl+R), print (Ctrl+P), back
 * and forward (Alt+←/→), the find bar (Ctrl+F, Ctrl+G, F3) and caret
 * browsing (F7). Only the browser's default is stopped: the app's own
 * handlers of the same keys (search, Go to row) still run.
 *
 * WebView2 (Windows) keeps these keys in release builds; WebKit (macOS,
 * Linux) has fewer of them, and the same list is harmless there.
 */
export function isBrowserKey(e: Keys, mac = isMac): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Reload, hard reload, caret browsing, find next / previous.
  if (key === "F5" || key === "F7" || key === "F3") return true;
  if (mod && !e.altKey && (key === "r" || key === "p" || key === "f" || key === "g")) return true;
  // Back and forward. On macOS Option+←/→ moves by word in text, and the
  // web view has no such navigation, so it is left alone there.
  if (!mac && e.altKey && !e.ctrlKey && !e.metaKey) {
    return key === "ArrowLeft" || key === "ArrowRight";
  }
  return false;
}

/** Text the user edits: dragging a selection inside it moves the text. */
function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable=''], [contenteditable='true']") !== null
  );
}

/**
 * Keeps the web view from acting like a web page: its context menu (reload,
 * print, inspect …), its browser shortcuts, the mouse's back and forward
 * buttons, and dragging images, icons or links out of the window. Text boxes
 * keep their own menu (cut, copy, paste) and text dragging; files dropped
 * onto the window still open (that's the system's drag and drop, not the
 * page's).
 */
export function useNativeGuards() {
  useEffect(() => {
    // Bubbling, on the window: the app's own handlers have run by now.
    const onKey = (e: KeyboardEvent) => {
      if (isBrowserKey(e)) e.preventDefault();
    };
    // Buttons 3 and 4 are the mouse's back and forward buttons.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    const onDragStart = (e: DragEvent) => {
      if (!isEditable(e.target)) e.preventDefault();
    };
    const onMenu = (e: MouseEvent) => {
      if (!isEditable(e.target)) e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouse);
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("dragstart", onDragStart);
    return () => {
      window.removeEventListener("contextmenu", onMenu);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouse);
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("dragstart", onDragStart);
    };
  }, []);
}
