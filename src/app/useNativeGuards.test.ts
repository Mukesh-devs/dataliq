import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isBrowserKey, useNativeGuards } from "./useNativeGuards";

const k = (
  key: string,
  mods: Partial<Record<"ctrl" | "meta" | "alt" | "shift", boolean>> = {},
) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("isBrowserKey", () => {
  it("stops reload, print, find and caret browsing (Windows, Linux)", () => {
    for (const e of [
      k("F5"),
      k("F5", { ctrl: true }),
      k("r", { ctrl: true }),
      k("R", { ctrl: true, shift: true }),
      k("p", { ctrl: true }),
      k("P", { ctrl: true, shift: true }),
      k("f", { ctrl: true }),
      k("g", { ctrl: true }),
      k("G", { ctrl: true, shift: true }),
      k("F3"),
      k("F3", { shift: true }),
      k("F7"),
      k("ArrowLeft", { alt: true }),
      k("ArrowRight", { alt: true }),
    ])
      expect(isBrowserKey(e, false), JSON.stringify(e)).toBe(true);
  });

  it("uses Cmd on macOS and leaves Option+arrows to text editing", () => {
    expect(isBrowserKey(k("r", { meta: true }), true)).toBe(true);
    expect(isBrowserKey(k("p", { meta: true }), true)).toBe(true);
    expect(isBrowserKey(k("r", { ctrl: true }), true)).toBe(false);
    expect(isBrowserKey(k("ArrowLeft", { alt: true }), true)).toBe(false);
  });

  it("leaves typing, editing and the app's other shortcuts alone", () => {
    for (const e of [
      k("r"),
      k("p"),
      k("F2"),
      k("ArrowLeft"),
      k("ArrowLeft", { ctrl: true }),
      k("ArrowLeft", { ctrl: true, alt: true }),
      k("ArrowUp", { alt: true }),
      k("c", { ctrl: true }),
      k("v", { ctrl: true }),
      k("z", { ctrl: true }),
      k("k", { ctrl: true }),
      k("o", { ctrl: true }),
      // AltGr on Windows is Ctrl+Alt: characters typed with it stay.
      k("r", { ctrl: true, alt: true }),
    ])
      expect(isBrowserKey(e, false), JSON.stringify(e)).toBe(false);
  });
});

describe("useNativeGuards", () => {
  let unmount: (() => void) | undefined;
  afterEach(() => {
    unmount?.();
    unmount = undefined;
    document.body.innerHTML = "";
  });

  const fire = (target: EventTarget, event: Event) => {
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("stops the browser's default but lets the app's handlers run", () => {
    ({ unmount } = renderHook(() => useNativeGuards()));
    let seen = 0;
    const app = (e: KeyboardEvent) => e.key === "f" && seen++;
    document.addEventListener("keydown", app);
    const ctrlF = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(fire(document.body, ctrlF)).toBe(true);
    expect(seen).toBe(1);
    document.removeEventListener("keydown", app);
    const typing = new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true });
    expect(fire(document.body, typing)).toBe(false);
  });

  it("stops the mouse's back and forward buttons", () => {
    ({ unmount } = renderHook(() => useNativeGuards()));
    for (const type of ["mousedown", "mouseup"]) {
      for (const button of [3, 4])
        expect(
          fire(document.body, new MouseEvent(type, { button, bubbles: true, cancelable: true })),
        ).toBe(true);
      expect(
        fire(document.body, new MouseEvent(type, { button: 0, bubbles: true, cancelable: true })),
      ).toBe(false);
    }
  });

  it("stops dragging images and links, but not text in a text box", () => {
    ({ unmount } = renderHook(() => useNativeGuards()));
    document.body.innerHTML = `<img alt="" src="data:,"><a href="#x">link</a><input value="text"><div contenteditable="true"><span>sql</span></div>`;
    const drag = () => new Event("dragstart", { bubbles: true, cancelable: true });
    expect(fire(document.querySelector("img")!, drag())).toBe(true);
    expect(fire(document.querySelector("a")!, drag())).toBe(true);
    expect(fire(document.querySelector("input")!, drag())).toBe(false);
    expect(fire(document.querySelector("span")!, drag())).toBe(false);
  });

  it("keeps the web view's context menu out, except in text boxes", () => {
    ({ unmount } = renderHook(() => useNativeGuards()));
    document.body.innerHTML = `<div id="grid"></div><textarea></textarea>`;
    const menu = () => new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    expect(fire(document.getElementById("grid")!, menu())).toBe(true);
    expect(fire(document.querySelector("textarea")!, menu())).toBe(false);
  });

  it("removes its listeners when unmounted", () => {
    const hook = renderHook(() => useNativeGuards());
    hook.unmount();
    const ctrlR = new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(fire(document.body, ctrlR)).toBe(false);
  });
});
