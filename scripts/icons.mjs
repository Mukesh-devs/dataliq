#!/usr/bin/env node
// The app icon: draws it and writes every file made from it.
//
//   node scripts/icons.mjs          (or `pnpm icons`)
//
// Writes the SVG sources in assets/ and, in src-tauri/icons/, the PNGs
// (Linux, Windows tiles), icon.ico (Windows) and icon.icns (macOS); also the
// website's copy of the icon and its favicons (website/assets/).
//
// Three drawings of one design, as desktop icons are made:
// - icon.svg, for macOS: Apple's grid, an 824 px tile in a 1024 px canvas
//   with its shadow, so it sits at the size of the icons around it in the
//   Dock and Launchpad.
// - icon-full.svg, for Windows and Linux: the tile fills the canvas, as
//   icons there do (the padded one would look small in a taskbar).
// - icon-small.svg, for 16–24 px (title bars, file lists): wider gaps and
//   no fine edge, so the cells stay apart instead of blurring together.
//
// Each size is drawn from the vectors at that size (not scaled down from a
// big bitmap). Needs the dev dependencies (Playwright's Chromium, the Tauri
// CLI for the .icns).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const f = (n) => Math.round(n * 100) / 100;

/** The glyph's cells as SVG, in the 1024 design space (tile 100–924). */
function glyph({ size = 500, gap = 36, stem = 132, k = 27, accent = "amber", cols = true } = {}) {
  const h = size,
    w = size,
    r = h / 2;
  // Optically centred: the bowl is lighter than the stem, so sit a little right of centre.
  const x0 = 512 - w / 2 + 6,
    y0 = 512 - h / 2;
  const cx = x0 + w - r,
    cy = y0 + r,
    R = r - k;
  const rowH = (h - 2 * gap) / 3;
  const arcX = (y) => cx + Math.sqrt(Math.max(0, R * R - (y - cy) ** 2));
  let cells = "";
  for (let i = 0; i < 3; i++) {
    const ya = y0 + i * (rowH + gap),
      yb = ya + rowH;
    const paint = (id) =>
      `fill="url(#${id})" stroke="url(#${id})" stroke-width="${2 * k}" stroke-linejoin="round"`;
    let xa = x0;
    if (cols) {
      const id = i === 0 && accent !== "none" ? accent : "brand";
      cells += `<path d="M ${f(x0 + k)} ${f(ya + k)} H ${f(x0 + stem - k)} V ${f(yb - k)} H ${f(x0 + k)} Z" ${paint(id)}/>`;
      xa = x0 + stem + gap;
    }
    cells += `<path d="M ${f(xa + k)} ${f(ya + k)} H ${f(arcX(ya + k))} A ${f(R)} ${f(R)} 0 0 1 ${f(arcX(yb - k))} ${f(yb - k)} H ${f(xa + k)} Z" ${paint("brand")}/>`;
  }
  return { cells, box: { x0, y0, x1: x0 + w, y1: y0 + h } };
}

/**
 * variant "mac": Apple's grid (an 824 px tile in the 1024 px canvas, with its shadow).
 * "full": the tile fills the canvas (Windows, Linux). "small": for 16–24 px, fewer details.
 */
export function icon({ variant = "mac", g = {} } = {}) {
  const small = variant === "small";
  const G = glyph(small ? { size: 560, gap: 56, stem: 150, k: 16, ...g } : g);
  const scale = variant === "mac" ? 1 : small ? 1024 / 824 : 968 / 824;
  const shadow = variant === "mac";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#272b3a"/>
      <stop offset="1" stop-color="#0f1117"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.26"/>
      <stop offset="0.35" stop-color="#ffffff" stop-opacity="0.03"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.06"/>
    </linearGradient>
    <linearGradient id="brand" gradientUnits="userSpaceOnUse" x1="${f(G.box.x0)}" y1="${f(G.box.y0)}" x2="${f(G.box.x1)}" y2="${f(G.box.y1)}">
      <stop offset="0" stop-color="#67e8f9"/>
      <stop offset="0.55" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#6366f1"/>
    </linearGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fde047"/>
      <stop offset="1" stop-color="#f59e0b"/>
    </linearGradient>
    <linearGradient id="light" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#cffafe"/>
    </linearGradient>${
      shadow
        ? `
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000000" flood-opacity="0.32"/>
    </filter>`
        : ""
    }
  </defs>
  <g${scale === 1 ? "" : ` transform="translate(512 512) scale(${f(scale * 1000) / 1000}) translate(-512 -512)"`}>
    <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"${shadow ? ' filter="url(#shadow)"' : ""}/>
    ${small ? "" : '<rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="url(#edge)" stroke-width="3"/>'}
    ${G.cells.replaceAll("/><", "/>\n    <")}
  </g>
</svg>
`;
}

/** An .ico file: 32-bit bitmaps, and PNG for 256 px (the only size the format compresses). */
export function ico(images) {
  const entries = images.map(({ size, rgba, png }) => {
    if (size >= 256) return { size, data: png };
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8); // the colours and the mask
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    const pixels = Buffer.alloc(size * size * 4);
    const maskRow = Math.ceil(size / 32) * 4;
    const mask = Buffer.alloc(maskRow * size);
    for (let y = 0; y < size; y++) {
      const out = size - 1 - y; // bottom row first
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const o = (out * size + x) * 4;
        pixels[o] = rgba[i + 2];
        pixels[o + 1] = rgba[i + 1];
        pixels[o + 2] = rgba[i];
        pixels[o + 3] = rgba[i + 3];
        if (rgba[i + 3] === 0) mask[out * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    header.writeUInt32LE(pixels.length + mask.length, 20);
    return { size, data: Buffer.concat([header, pixels, mask]) };
  });
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach(({ size, data }, n) => {
    const e = 6 + 16 * n;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

/** Sizes drawn from the simplified icon. */
const SMALL_UP_TO = 24;

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const assets = join(root, "assets");
  const icons = join(root, "src-tauri", "icons");
  const svg = {
    mac: icon({ variant: "mac" }),
    full: icon({ variant: "full" }),
    small: icon({ variant: "small" }),
  };
  writeFileSync(join(assets, "icon.svg"), svg.mac);
  writeFileSync(join(assets, "icon-full.svg"), svg.full);
  writeFileSync(join(assets, "icon-small.svg"), svg.small);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  /** One size of one drawing, as PNG bytes and raw RGBA. */
  const draw = async (variant, size) => {
    const out = await page.evaluate(
      async ({ source, size }) => {
        const img = new Image();
        img.src = `data:image/svg+xml;base64,${btoa(source)}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, size, size);
        const rgba = ctx.getImageData(0, 0, size, size).data;
        let raw = "";
        for (let i = 0; i < rgba.length; i += 8192)
          raw += String.fromCharCode(...rgba.subarray(i, i + 8192));
        return { png: canvas.toDataURL("image/png").split(",")[1], rgba: btoa(raw) };
      },
      { source: svg[variant], size },
    );
    return { size, png: Buffer.from(out.png, "base64"), rgba: Buffer.from(out.rgba, "base64") };
  };
  const sized = (size) => draw(size <= SMALL_UP_TO ? "small" : "full", size);

  // Linux (hicolor sizes) and the window icon; Windows Store tiles.
  const pngs = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "StoreLogo.png": 50,
    ...Object.fromEntries(
      [30, 44, 71, 89, 107, 142, 150, 284, 310].map((s) => [`Square${s}x${s}Logo.png`, s]),
    ),
  };
  for (const [name, size] of Object.entries(pngs))
    writeFileSync(join(icons, name), (await sized(size)).png);

  // The website (website/, GitHub Pages): its logo, favicons and home-screen icons.
  const site = join(root, "website", "assets");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "icon.svg"), svg.full);
  for (const [name, size] of Object.entries({
    "favicon-32.png": 32,
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
  }))
    writeFileSync(join(site, name), (await sized(size)).png);

  // Windows: every size Explorer, the taskbar and the title bar ask for.
  const layers = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) layers.push(await sized(size));
  writeFileSync(join(icons, "icon.ico"), ico(layers));

  // macOS: the Tauri CLI packs the .icns from the 1024 px drawing.
  const tmp = mkdtempSync(join(tmpdir(), "dataliq-icon-"));
  try {
    const source = join(tmp, "mac.png");
    writeFileSync(source, (await draw("mac", 1024)).png);
    mkdirSync(join(tmp, "out"));
    execFileSync("pnpm", ["exec", "tauri", "icon", source, "-o", join(tmp, "out")], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    copyFileSync(join(tmp, "out", "icon.icns"), join(icons, "icon.icns"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await browser.close();
  }
  console.log(`Icons written to ${icons}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
