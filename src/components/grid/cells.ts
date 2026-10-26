import { GridCellKind, type GridCell } from "@glideapps/glide-data-grid";
import type { ColumnKind, ValueFormat } from "../../lib/arrow";
import { formatValue } from "../../lib/format";
import { NOT_LOADED, type CellResult } from "./rowSource";

/** Longest text drawn in a cell; the full value is still copied. */
const MAX_DISPLAY = 400;

export interface CellStyle {
  /** Colour for NULL and empty-string markers. */
  nullColor: string;
  /** Font for NULL markers, e.g. "italic 12px". */
  nullFont: string;
}

const loading: GridCell = { kind: GridCellKind.Loading, allowOverlay: false };

/** Converts one value to a read-only Glide cell, by column kind. */
export function toGridCell(
  value: CellResult,
  format: ColumnKind | ValueFormat,
  style: CellStyle,
): GridCell {
  if (value === NOT_LOADED) return loading;
  const kind = typeof format === "string" ? format : format.kind;
  const text = formatValue(value, format);
  if (text === null) {
    return {
      kind: GridCellKind.Text,
      data: "",
      displayData: "null",
      copyData: "",
      allowOverlay: false,
      readonly: true,
      contentAlign: kind === "integer" || kind === "number" ? "right" : "left",
      themeOverride: { textDark: style.nullColor, baseFontStyle: style.nullFont },
    };
  }
  switch (kind) {
    case "integer":
    case "number":
      return {
        kind: GridCellKind.Number,
        data: typeof value === "bigint" ? Number(value) : Number(value),
        displayData: text,
        copyData: text,
        allowOverlay: false,
        readonly: true,
        contentAlign: "right",
      };
    case "boolean":
      return {
        kind: GridCellKind.Boolean,
        data: Boolean(value),
        allowOverlay: false,
        readonly: true,
        copyData: text,
      };
    case "json":
      return {
        kind: GridCellKind.Text,
        data: prettyJson(value) ?? text,
        displayData: text.length > MAX_DISPLAY ? `${text.slice(0, MAX_DISPLAY)}…` : text,
        copyData: text,
        // Click to expand: the overlay shows the value pretty-printed.
        allowOverlay: true,
        readonly: true,
      };
    default:
      if (text === "") {
        return {
          kind: GridCellKind.Text,
          data: "",
          displayData: '""',
          copyData: "",
          allowOverlay: false,
          readonly: true,
          themeOverride: { textDark: style.nullColor },
        };
      }
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: text.length > MAX_DISPLAY ? `${text.slice(0, MAX_DISPLAY)}…` : text,
        copyData: text,
        // Long values and JSON can be read in full in the read-only overlay.
        allowOverlay: true,
        readonly: true,
      };
  }
}

function prettyJson(value: unknown): string | null {
  try {
    return JSON.stringify(JSON.parse(formatValue(value, "json") ?? "null"), null, 2);
  } catch {
    return null;
  }
}

/** Starting width for a column, from its name and kind. */
export function initialWidth(name: string, kind: ColumnKind): number {
  const byKind: Partial<Record<ColumnKind, number>> = {
    integer: 90,
    number: 110,
    boolean: 80,
    date: 110,
    timestamp: 180,
    time: 100,
    json: 220,
  };
  const forName = name.length * 8 + 44;
  return Math.min(360, Math.max(byKind[kind] ?? 160, forName));
}
