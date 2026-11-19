import { isMac, isWindows } from "./platform";

/** How long a panel's scroll bar stays after it last moved. */
const SHOWN_MS = 900;

/**
 * Tags the page with its platform (`data-platform` on <html>), so the styles
 * can leave macOS its own overlay scroll bars.
 */
export function markPlatform(root: HTMLElement = document.documentElement): void {
  root.dataset.platform = isMac ? "mac" : isWindows ? "windows" : "linux";
}

/**
 * Shows a panel's scroll bar while it scrolls (by wheel, keyboard or a
 * drag), even when the pointer is elsewhere, then lets it fade out of sight
 * a moment after it stops: the `is-scrolling` class the styles look for.
 * Returns a function that stops it.
 */
export function showScrollbarsWhileScrolling(doc: Document = document): () => void {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  const onScroll = (e: Event) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    el.classList.add("is-scrolling");
    clearTimeout(timers.get(el));
    timers.set(
      el,
      setTimeout(() => el.classList.remove("is-scrolling"), SHOWN_MS),
    );
  };
  // Scroll events don't bubble: listen while they go down to their target.
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => doc.removeEventListener("scroll", onScroll, { capture: true });
}
