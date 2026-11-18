import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { clampWidth, MIN_MAIN } from "../../stores/layout";
import { Resizable } from "./Resizable";

function Panel({ side = "left" as "left" | "right", other = 0 }) {
  const [width, setWidth] = useState(240);
  return (
    <Resizable
      side={side}
      width={width}
      defaultWidth={240}
      min={180}
      otherWidth={other}
      onWidth={setWidth}
      label="Resize the sidebar"
    >
      <div data-testid="body" />
    </Resizable>
  );
}

const edge = () => screen.getByRole("separator", { name: "Resize the sidebar" });

describe("clampWidth", () => {
  it("keeps a panel above its minimum and the grid's room free", () => {
    expect(clampWidth(100, 180, 1280, 0)).toBe(180);
    expect(clampWidth(500, 180, 1280, 0)).toBe(500);
    expect(clampWidth(2000, 180, 1280, 288)).toBe(1280 - 288 - MIN_MAIN);
    // A window too small for both: the minimum wins.
    expect(clampWidth(300, 180, 400, 288)).toBe(180);
  });
});

describe("Resizable", () => {
  it("drags the inner edge, within the limits", () => {
    render(<Panel />);
    // jsdom's window is 1024 px wide.
    expect(edge()).toHaveAttribute("aria-valuenow", "240");
    fireEvent.pointerDown(edge(), { button: 0, clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(edge(), { clientX: 340, pointerId: 1 });
    expect(edge()).toHaveAttribute("aria-valuenow", "340");
    fireEvent.pointerMove(edge(), { clientX: 2000, pointerId: 1 });
    expect(edge()).toHaveAttribute("aria-valuenow", String(1024 - MIN_MAIN));
    fireEvent.pointerMove(edge(), { clientX: 0, pointerId: 1 });
    expect(edge()).toHaveAttribute("aria-valuenow", "180");
    fireEvent.pointerUp(edge(), { pointerId: 1 });
    // Moving without a press does nothing.
    fireEvent.pointerMove(edge(), { clientX: 500, pointerId: 1 });
    expect(edge()).toHaveAttribute("aria-valuenow", "180");
  });

  it("goes back to the default width on a double-click", () => {
    render(<Panel />);
    fireEvent.pointerDown(edge(), { button: 0, clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(edge(), { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(edge(), { pointerId: 1 });
    fireEvent.doubleClick(edge());
    expect(edge()).toHaveAttribute("aria-valuenow", "240");
  });

  it("moves with the arrow keys; a right panel's edge moves the other way", () => {
    const { unmount } = render(<Panel />);
    fireEvent.keyDown(edge(), { key: "ArrowRight" });
    expect(edge()).toHaveAttribute("aria-valuenow", "256");
    fireEvent.keyDown(edge(), { key: "ArrowLeft", shiftKey: true });
    expect(edge()).toHaveAttribute("aria-valuenow", "192");
    fireEvent.keyDown(edge(), { key: "Home" });
    expect(edge()).toHaveAttribute("aria-valuenow", "180");
    fireEvent.keyDown(edge(), { key: "Enter" });
    expect(edge()).toHaveAttribute("aria-valuenow", "240");
    unmount();

    render(<Panel side="right" />);
    fireEvent.keyDown(edge(), { key: "ArrowLeft" });
    expect(edge()).toHaveAttribute("aria-valuenow", "256");
  });

  it("leaves room for the panel on the other side", () => {
    render(<Panel other={288} />);
    fireEvent.keyDown(edge(), { key: "End" });
    expect(edge()).toHaveAttribute("aria-valuenow", String(1024 - 288 - MIN_MAIN));
  });
});
