import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.2 AA contrast of the theme tokens: text 4.5:1 against every
 * background it is drawn on (1.4.3), the focus ring 3:1 (1.4.11).
 */
const css = readFileSync(join(__dirname, "tokens.css"), "utf8");

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

/** [r, g, b, alpha] from `#rrggbb` or `rgb(r g b / a)`. */
function parse(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(color);
  if (!rgb) throw new Error(`can't read colour ${color}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4])];
}

function luminance([r, g, b]: number[]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

/** `color` (translucent) laid over `bg`, as `#rrggbb`. */
function over(color: string, bg: string): string {
  const [r, g, b, a] = parse(color);
  const [br, bgG, bb] = parse(bg);
  const mix = [r * a + br * (1 - a), g * a + bgG * (1 - a), b * a + bb * (1 - a)];
  return `#${mix.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Contrast of `fg` (blended over `bg` if translucent) against `bg`. */
function contrast(fg: string, bg: string): number {
  const [br, bgG, bb] = parse(bg);
  const [r, g, b, a] = parse(fg);
  const mixed = [r * a + br * (1 - a), g * a + bgG * (1 - a), b * a + bb * (1 - a)];
  const [hi, lo] = [luminance(mixed), luminance([br, bgG, bb])].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT = [
  "fg",
  "fg-muted",
  "fg-subtle",
  "null",
  "accent",
  "danger",
  "warning",
  "success",
  "syntax-keyword",
  "syntax-string",
  "syntax-number",
  "syntax-comment",
  "syntax-name",
];
const BACKGROUNDS = ["bg", "surface", "surface-2", "hover"];

describe.each([
  ["light", ':root[data-theme="light"] {'],
  ["dark", ':root[data-theme="dark"] {'],
])("%s theme contrast", (_name, selector) => {
  const t = tokens(selector);

  // Selected rows (palette, lists) are tinted with --accent-soft over the page.
  const backgrounds = [
    ...BACKGROUNDS.map((bg) => [bg, t[bg]!] as const),
    ["accent-soft on bg", over(t["accent-soft"]!, t.bg!)] as const,
    ["accent-soft on surface", over(t["accent-soft"]!, t.surface!)] as const,
  ];

  it.each(TEXT)("--%s text is readable on every background", (fg) => {
    for (const [name, bg] of backgrounds)
      expect(contrast(t[fg]!, bg), `--${fg} on ${name}`).toBeGreaterThanOrEqual(4.5);
  });

  it("text on the accent colour is readable", () => {
    expect(contrast(t["accent-fg"]!, t.accent!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["accent-fg"]!, t["accent-hover"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("the focus ring stands out", () => {
    for (const bg of BACKGROUNDS)
      expect(contrast(t["focus-ring"]!, t[bg]!), `ring on --${bg}`).toBeGreaterThanOrEqual(3);
  });
});
