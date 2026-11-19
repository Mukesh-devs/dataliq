import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, roomAt, stepZoom, zoomKey, zoomLabel } from "./zoom";

const keys = (key: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key, code: "", ctrlKey: true, metaKey: false, altKey: false, ...extra }) as KeyboardEvent;

describe("zoom", () => {
  it("steps through the levels and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.2, 1)).toBe(1.25);
    expect(stepZoom(1.2, -1)).toBe(1.1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("stops zooming in before the layout gets cramped", () => {
    // A 1280 x 800 window at 100%: 200% would leave 640 x 400.
    expect(roomAt(2, 1, 1280, 800)).toBe(true);
    // The smallest window (720 x 480) has room up to 110%, not 125%.
    expect(roomAt(1.1, 1, 720, 480)).toBe(true);
    expect(roomAt(1.25, 1, 720, 480)).toBe(false);
    // Sizes are measured at the current zoom: at 150%, 854 x 534 CSS px is 1281 x 801.
    expect(roomAt(2, 1.5, 854, 534)).toBe(true);
    expect(roomAt(2, 1.5, 852, 534)).toBe(false);
  });

  it("reads the zoom keys from the main keys and the number pad", () => {
    expect(zoomKey(keys("="), false)).toBe("in");
    expect(zoomKey(keys("+"), false)).toBe("in");
    expect(zoomKey(keys("+", { code: "NumpadAdd" }), false)).toBe("in");
    expect(zoomKey(keys("-"), false)).toBe("out");
    expect(zoomKey(keys("_"), false)).toBe("out");
    expect(zoomKey(keys("0"), false)).toBe("reset");
    // Not without the modifier, nor with Alt (AltGr on Windows).
    expect(zoomKey(keys("=", { ctrlKey: false }), false)).toBeNull();
    expect(zoomKey(keys("=", { altKey: true }), false)).toBeNull();
    // Cmd on macOS.
    expect(zoomKey(keys("=", { ctrlKey: false, metaKey: true }), true)).toBe("in");
    expect(zoomKey(keys("="), true)).toBeNull();
  });

  it("labels a level as a percentage", () => {
    expect(zoomLabel(1.1)).toBe("110%");
    expect(zoomLabel(0.67)).toBe("67%");
  });
});
