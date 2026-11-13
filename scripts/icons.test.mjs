// node --test scripts/icons.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ico, icon } from "./icons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p));

test("the committed SVGs are what the script draws", () => {
  for (const [file, variant] of [
    ["icon.svg", "mac"],
    ["icon-full.svg", "full"],
    ["icon-small.svg", "small"],
  ])
    assert.equal(read("assets", file).toString(), icon({ variant }), `${file}: run pnpm icons`);
});

test("the macOS drawing keeps Apple's margin; the others fill the canvas", () => {
  assert.match(icon({ variant: "mac" }), /<rect x="100" y="100" width="824" height="824"/);
  assert.match(icon({ variant: "mac" }), /feDropShadow/);
  assert.match(icon({ variant: "full" }), /scale\(1\.17476\)/);
  assert.doesNotMatch(icon({ variant: "full" }), /feDropShadow/);
});

test("an .ico holds bitmaps, and PNG only at 256 px", () => {
  const rgba = (size) => Buffer.alloc(size * size * 4, 255);
  const png = Buffer.from("\x89PNG-data", "latin1");
  const file = ico([
    { size: 16, rgba: rgba(16), png },
    { size: 256, rgba: rgba(256), png },
  ]);
  assert.deepEqual([file.readUInt16LE(2), file.readUInt16LE(4)], [1, 2]);
  // 16 px: a 40-byte header, 16×16 BGRA, and a mask of 4-byte rows.
  assert.equal(file[6], 16);
  assert.equal(file.readUInt32LE(6 + 8), 40 + 16 * 16 * 4 + 16 * 4);
  const first = file.readUInt32LE(6 + 12);
  assert.equal(file.readUInt32LE(first), 40);
  assert.equal(file.readInt32LE(first + 8), 32, "height counts the mask too");
  // 256 px: width 0 in the directory, PNG bytes as they are.
  assert.equal(file[6 + 16], 0);
  const second = file.readUInt32LE(6 + 16 + 12);
  assert.equal(file.subarray(second).toString("latin1"), "\x89PNG-data");
});

test("the shipped icon.ico has every Windows size, the .icns is there", () => {
  const file = read("src-tauri", "icons", "icon.ico");
  const sizes = Array.from({ length: file.readUInt16LE(4) }, (_, i) => file[6 + 16 * i] || 256);
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
  assert.equal(read("src-tauri", "icons", "icon.icns").subarray(0, 4).toString(), "icns");
});
