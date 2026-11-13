// node --test scripts/website.test.mjs
// The website's release logic (website/js/release-assets.js) and its files.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyAssets,
  detectOS,
  formatDate,
  formatSize,
  summarize,
} from "../website/js/release-assets.js";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "website");
const dl = (name) => `https://github.com/Mukesh-devs/dataliq/releases/download/v1.2.3/${name}`;
const asset = (name, size = 20_000_000) => ({ name, size, browser_download_url: dl(name) });

// The files a release holds (docs/RELEASING.md).
const RELEASE = {
  tag_name: "v1.2.3",
  name: "DataLiq 1.2.3",
  html_url: "https://github.com/Mukesh-devs/dataliq/releases/tag/v1.2.3",
  published_at: "2026-10-29T11:38:47Z",
  body: "Notes",
  assets: [
    asset("DataLiq-1.2.3-1.x86_64.rpm"),
    asset("DataLiq_1.2.3_aarch64.dmg"),
    asset("DataLiq_1.2.3_aarch64.app.tar.gz"),
    asset("DataLiq_1.2.3_aarch64.app.tar.gz.sig", 400),
    asset("DataLiq_1.2.3_amd64.AppImage", 99_100_000),
    asset("DataLiq_1.2.3_amd64.deb"),
    asset("DataLiq_1.2.3_x64-setup.exe", 14_600_000),
    asset("DataLiq_1.2.3_x64.dmg"),
    asset("DataLiq_1.2.3_x64_en-US.msi"),
    asset("SHA256SUMS.txt", 900),
    asset("latest.json", 1200),
  ],
};

test("a release's files are sorted into downloads per system, recommended first", () => {
  const d = classifyAssets(RELEASE.assets);
  assert.deepEqual(
    d.windows.map((a) => a.label),
    ["Installer", "MSI package"],
  );
  assert.deepEqual(
    d.macos.map((a) => a.label),
    ["Apple silicon", "Intel"],
  );
  assert.deepEqual(
    d.linux.map((a) => a.label),
    ["AppImage", ".deb", ".rpm"],
  );
  assert.equal(d.windows[0].url, dl("DataLiq_1.2.3_x64-setup.exe"));
  assert.equal(d.windows[0].size, "14.6 MB");
  assert.equal(d.checksums, dl("SHA256SUMS.txt"));
  // Signatures, update archives and the updater's manifest are not downloads.
  const names = [...d.windows, ...d.macos, ...d.linux].map((a) => a.name).join(" ");
  assert.doesNotMatch(names, /\.sig|\.tar\.gz|latest\.json/);
});

test("a universal macOS image and a missing system are handled", () => {
  const d = classifyAssets([
    asset("DataLiq_1.0.0_universal.dmg"),
    asset("DataLiq_1.0.0_amd64.deb"),
  ]);
  assert.equal(d.macos[0].label, "Universal");
  assert.deepEqual(d.windows, []);
  assert.equal(d.checksums, null);
  assert.deepEqual(classifyAssets(undefined), {
    windows: [],
    macos: [],
    linux: [],
    checksums: null,
  });
});

test("only downloads hosted by GitHub are offered", () => {
  const d = classifyAssets([
    {
      name: "DataLiq_9_x64-setup.exe",
      size: 1,
      browser_download_url: "https://evil.example/DataLiq_9_x64-setup.exe",
    },
    { name: "DataLiq_9_amd64.deb", size: 1, browser_download_url: "javascript:alert(1)" },
    { name: "DataLiq_9_x64.dmg", size: 1, browser_download_url: "http://github.com/x.dmg" },
  ]);
  assert.deepEqual([d.windows, d.macos, d.linux], [[], [], []]);
});

test("the visitor's system is told from the browser; phones and tablets get none", () => {
  const os = (userAgent, platform = "", maxTouchPoints = 0) =>
    detectOS({ userAgent, platform, maxTouchPoints });
  assert.equal(os("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(os("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel"), "macos");
  assert.equal(os("Mozilla/5.0 (X11; Linux x86_64)"), "linux");
  assert.equal(os("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)"), "linux");
  assert.equal(os("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148"), null);
  assert.equal(os("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile"), null);
  // iPadOS calls itself a Mac, but has a touch screen.
  assert.equal(os("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5), null);
  assert.equal(os(""), null);
});

test("a release is summarized for the page; anything else is not a release", () => {
  const r = summarize(RELEASE);
  assert.equal(r.version, "1.2.3");
  assert.equal(r.hasDownloads, true);
  assert.equal(r.url, RELEASE.html_url);
  assert.equal(formatDate(r.publishedAt), "29 October 2026");
  assert.equal(summarize({ tag_name: "v2.0.0", assets: [] }).hasDownloads, false);
  assert.equal(summarize({ message: "Not Found" }), null);
  assert.equal(summarize(null), null);
  assert.equal(formatDate("nonsense"), "");
});

test("sizes read plainly", () => {
  assert.equal(formatSize(99_100_000), "99.1 MB");
  assert.equal(formatSize(123_456_789), "123 MB");
  assert.equal(formatSize(900), "1 KB");
  assert.equal(formatSize(0), "");
});

test("the page has no version or download link written into it", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  assert.doesNotMatch(html, /releases\/download\//, "download links come from the API");
  // Not counting drawings (SVG path data) and the structured data block.
  const text = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(text, /\bv?\d+\.\d+\.\d+\b/, "no version number in the page");
});

test("every local file the page names exists", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  const refs = new Set();
  for (const m of html.matchAll(/(?<![-\w])(?:src|href)="([^"#:]+)"/g)) refs.add(m[1]);
  for (const m of html.matchAll(/(?:srcset|imagesrcset)="([^"]+)"/g))
    for (const part of m[1].split(",")) refs.add(part.trim().split(/\s+/)[0]);
  for (const m of html.matchAll(/data-(?:lazy|src|shot)="([^"]+)"/g))
    for (const w of [1280, 2560]) refs.add(`assets/shots/${m[1]}-${w}.webp`);
  assert.ok(refs.size > 20);
  for (const ref of refs) assert.ok(existsSync(join(site, ref)), `${ref} is missing`);
});
