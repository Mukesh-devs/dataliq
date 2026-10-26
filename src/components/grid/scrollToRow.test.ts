import { describe, expect, it } from "vitest";
import { scrollToRow } from "./scrollToRow";

/** A fake scroller whose height is capped like a browser's. */
function fakeScroller(scrollHeight: number, clientHeight: number) {
  const events: number[] = [];
  const el = {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    dispatchEvent: () => {
      events.push(el.scrollTop);
      return true;
    },
  };
  return { el: el as unknown as HTMLElement, events };
}

describe("scrollToRow", () => {
  it("scrolls 1:1 when the table fits under the height cap", () => {
    const { el } = fakeScroller(32 + 1000 * 28, 700);
    scrollToRow(el, 500, 28, 32, 1000);
    expect(el.scrollTop).toBe(498 * 28);
  });

  it("maps proportionally for 50M rows so the target lands in view", () => {
    const rows = 50_000_000;
    const cap = 33_554_400;
    const { el } = fakeScroller(cap, 700);
    scrollToRow(el, 25_000_000, 28, 32, rows);
    // Glide's mapping: virtual = real / realScrollable * virtualScrollable.
    const virtual = (el.scrollTop / (cap - 700)) * (32 + rows * 28 - 700);
    const topRow = Math.floor(virtual / 28);
    expect(topRow).toBeGreaterThanOrEqual(25_000_000 - 4);
    expect(topRow).toBeLessThanOrEqual(25_000_000);
  });

  it("hops first when the jump is too small for Glide to remap", () => {
    const { el, events } = fakeScroller(33_554_400, 700);
    el.scrollTop = 100;
    scrollToRow(el, 3000, 28, 32, 50_000_000);
    expect(events).toHaveLength(2);
    expect(Math.abs(events[0]! - 100)).toBeGreaterThan(2000);
  });
});
