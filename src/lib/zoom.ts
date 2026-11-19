/** The zoom levels Zoom in and Zoom out step through, as in code editors. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const MIN_ZOOM = ZOOM_LEVELS[0];
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;

/**
 * Below this many CSS pixels the app's layout gets too cramped (the
 * sidebar, the grid and the toolbars): zooming in stops before it.
 */
export const MIN_ZOOMED_SIZE = { width: 640, height: 400 } as const;

/** The next level up or down from `current` (which may sit between levels). */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((z) => z > current + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 0.001) ?? MIN_ZOOM;
}

/**
 * Whether the window still has room at `zoom`: `width` and `height` are its
 * size in CSS pixels at the `current` zoom.
 */
export function roomAt(zoom: number, current: number, width: number, height: number): boolean {
  return (
    (width * current) / zoom >= MIN_ZOOMED_SIZE.width &&
    (height * current) / zoom >= MIN_ZOOMED_SIZE.height
  );
}

/** "110%". */
export const zoomLabel = (zoom: number): string => `${Math.round(zoom * 100)}%`;

type Keys = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">;

/**
 * Ctrl+= or Ctrl++ zooms in, Ctrl+- zooms out and Ctrl+0 resets (Cmd on
 * macOS), from the main keys or the number pad, whatever the keyboard
 * layout puts on Shift.
 */
export function zoomKey(e: Keys, mac: boolean): "in" | "out" | "reset" | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return null;
  if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") return "in";
  if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return "out";
  if (e.key === "0" || e.code === "Numpad0") return "reset";
  return null;
}
