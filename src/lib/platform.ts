/** True when running on macOS (Cmd instead of Ctrl for shortcuts). */
export const isMac: boolean =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Label for the primary shortcut modifier on this platform. */
export const modKey: string = isMac ? "⌘" : "Ctrl";

/** Formats a shortcut like "Mod+K" for display, e.g. "⌘K" or "Ctrl+K". */
export function formatShortcut(shortcut: string, mac: boolean = isMac): string {
  const parts = shortcut.split("+").map((p) => {
    if (p === "Mod") return mac ? "⌘" : "Ctrl";
    if (p === "Shift") return mac ? "⇧" : "Shift";
    if (p === "Alt") return mac ? "⌥" : "Alt";
    return p;
  });
  return mac ? parts.join("") : parts.join("+");
}
