import { GridCellKind } from "@glideapps/glide-data-grid";
import { describe, expect, it } from "vitest";
import { initialWidth, toGridCell } from "./cells";
import { NOT_LOADED } from "./rowSource";

const style = { nullColor: "#999", nullFont: "italic 12px" };

describe("toGridCell", () => {
  it("shows a loading cell until the page arrives", () => {
    expect(toGridCell(NOT_LOADED, "text", style).kind).toBe(GridCellKind.Loading);
  });

  it("renders NULL as a faded italic marker that copies as empty", () => {
    const cell = toGridCell(null, "integer", style);
    expect(cell).toMatchObject({
      kind: GridCellKind.Text,
      displayData: "null",
      copyData: "",
      contentAlign: "right",
      themeOverride: { textDark: "#999", baseFontStyle: "italic 12px" },
    });
  });

  it("renders an empty string differently from NULL", () => {
    const cell = toGridCell("", "text", style);
    expect(cell).toMatchObject({ displayData: '""', copyData: "" });
    expect(cell.themeOverride?.baseFontStyle).toBeUndefined();
  });

  it("right-aligns numbers and keeps big integers exact", () => {
    const cell = toGridCell(9007199254740993n, "integer", style);
    expect(cell).toMatchObject({
      kind: GridCellKind.Number,
      displayData: "9007199254740993",
      copyData: "9007199254740993",
      contentAlign: "right",
    });
  });

  it("uses checkboxes for booleans and text for dates", () => {
    expect(toGridCell(true, "boolean", style)).toMatchObject({
      kind: GridCellKind.Boolean,
      data: true,
    });
    expect(toGridCell(Date.UTC(2024, 0, 31), "date", style)).toMatchObject({
      displayData: "2024-01-31",
    });
  });

  it("truncates very long text for display but copies all of it", () => {
    const long = "x".repeat(1000);
    const cell = toGridCell(long, "text", style);
    expect(cell).toMatchObject({ copyData: long });
    expect((cell as { displayData: string }).displayData.length).toBe(401);
  });
});

describe("initialWidth", () => {
  it("fits the name, within limits", () => {
    expect(initialWidth("id", "integer")).toBe(90);
    expect(initialWidth("a_rather_long_column_name", "text")).toBe(244);
    expect(initialWidth("x".repeat(100), "text")).toBe(360);
  });
});
