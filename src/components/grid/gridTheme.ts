import type { Theme } from "@glideapps/glide-data-grid";

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

/**
 * Builds the canvas grid theme from the CSS design tokens. The grid draws on
 * a canvas, so it cannot use CSS variables directly; call this again after
 * the theme changes.
 */
export function gridTheme(root: HTMLElement = document.documentElement): Partial<Theme> {
  const s = getComputedStyle(root);
  const v = (name: string, fallback: string) => cssVar(s, name, fallback);
  const mono = v("--font-data", "monospace");
  return {
    accentColor: v("--accent", "#4f46e5"),
    accentFg: v("--accent-fg", "#ffffff"),
    accentLight: v("--accent-soft", "rgba(79,70,229,0.12)"),
    textDark: v("--fg", "#18181b"),
    textMedium: v("--fg-muted", "#52525b"),
    textLight: v("--fg-subtle", "#8b8b94"),
    textBubble: v("--fg", "#18181b"),
    bgIconHeader: v("--fg-subtle", "#8b8b94"),
    fgIconHeader: v("--bg", "#ffffff"),
    textHeader: v("--fg", "#18181b"),
    textHeaderSelected: v("--accent-fg", "#ffffff"),
    bgCell: v("--bg", "#ffffff"),
    bgCellMedium: v("--surface", "#f8f8f9"),
    bgHeader: v("--surface", "#f8f8f9"),
    bgHeaderHasFocus: v("--active", "#e4e4e8"),
    bgHeaderHovered: v("--hover", "#ececef"),
    bgBubble: v("--surface-2", "#f1f1f3"),
    bgBubbleSelected: v("--bg", "#ffffff"),
    bgSearchResult: v("--accent-soft", "rgba(79,70,229,0.12)"),
    borderColor: v("--border", "#e6e6ea"),
    horizontalBorderColor: v("--border", "#e6e6ea"),
    headerBottomBorderColor: v("--border-strong", "#d4d4da"),
    drilldownBorder: v("--border-strong", "#d4d4da"),
    linkColor: v("--accent", "#4f46e5"),
    resizeIndicatorColor: v("--accent", "#4f46e5"),
    fontFamily: mono,
    baseFontStyle: "12px",
    headerFontStyle: "600 12px",
    markerFontStyle: "11px",
    editorFontSize: "12px",
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3,
    headerIconSize: 16,
    lineHeight: 1.4,
  };
}

/** Background behind search matches in cells. */
export function matchColor(root: HTMLElement = document.documentElement): string {
  return cssVar(getComputedStyle(root), "--match", "rgba(250,204,21,0.45)");
}

/** Bars of the histograms in the headers. */
export function chartColor(root: HTMLElement = document.documentElement): string {
  return cssVar(getComputedStyle(root), "--chart-bar", "rgba(79,70,229,0.4)");
}

export function nullColor(root: HTMLElement = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue("--null").trim() || "#a1a1aa";
}

/** Row height in px for the current density (from the --row-height token). */
export function rowHeight(root: HTMLElement = document.documentElement): number {
  const px = parseFloat(getComputedStyle(root).getPropertyValue("--row-height"));
  return Number.isFinite(px) && px > 0 ? px : 28;
}

/** A comparison's cell fills: changed cells, added and removed rows. */
export type CellTint = "changed" | "added" | "removed";

export function tintColors(root: HTMLElement = document.documentElement): Record<CellTint, string> {
  const s = getComputedStyle(root);
  return {
    changed: cssVar(s, "--diff-changed", "rgba(245,158,11,0.2)"),
    added: cssVar(s, "--diff-added", "rgba(22,163,74,0.14)"),
    removed: cssVar(s, "--diff-removed", "rgba(220,38,38,0.12)"),
  };
}
