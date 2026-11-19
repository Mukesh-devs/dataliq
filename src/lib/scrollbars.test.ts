import { afterEach, describe, expect, it, vi } from "vitest";
import { markPlatform, showScrollbarsWhileScrolling } from "./scrollbars";

describe("scroll bars", () => {
  afterEach(() => vi.useRealTimers());

  it("tags the page with its platform", () => {
    const root = document.createElement("html");
    markPlatform(root);
    expect(root.dataset.platform).toMatch(/^(mac|windows|linux)$/);
  });

  it("shows a panel's bar while it scrolls, then hides it a moment after", () => {
    vi.useFakeTimers();
    const stop = showScrollbarsWhileScrolling();
    const panel = document.createElement("div");
    document.body.append(panel);
    panel.dispatchEvent(new Event("scroll"));
    expect(panel).toHaveClass("is-scrolling");
    vi.advanceTimersByTime(500);
    // Still moving: the moment starts again.
    panel.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(600);
    expect(panel).toHaveClass("is-scrolling");
    vi.advanceTimersByTime(400);
    expect(panel).not.toHaveClass("is-scrolling");
    stop();
    panel.dispatchEvent(new Event("scroll"));
    expect(panel).not.toHaveClass("is-scrolling");
    panel.remove();
  });
});
