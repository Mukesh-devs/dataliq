// node --test scripts/release/
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildManifest,
  classify,
  releaseName,
  releaseNotes,
  sha256sums,
  versionOfTag,
} from "./lib.mjs";

const v = "1.0.0";
const bundles = [
  `DataLiq_${v}_x64-setup.exe`,
  `DataLiq_${v}_x64_en-US.msi`,
  `DataLiq_${v}_universal.dmg`,
  `DataLiq_${v}_universal.app.tar.gz`,
  `DataLiq_${v}_amd64.AppImage`,
  `DataLiq_${v}_amd64.deb`,
  `DataLiq-${v}-1.x86_64.rpm`,
];

test("every installer Tauri builds is released, nothing else", () => {
  for (const name of bundles) assert.ok(classify(name), name);
  for (const name of [
    "DataLiq.app",
    `DataLiq_${v}_amd64.AppImage.sig`,
    "dataliq",
    "latest.json",
    `DataLiq_${v}_aarch64.dmg`,
  ])
    assert.equal(classify(name), null, name);
});

test("the macOS update bundle gets the version in its name", () => {
  assert.equal(releaseName("DataLiq.app.tar.gz", v), `DataLiq_${v}_universal.app.tar.gz`);
  assert.equal(releaseName(`DataLiq_${v}_amd64.deb`, v), `DataLiq_${v}_amd64.deb`);
});

test("latest.json lists each signed bundle under every key the updater looks up", () => {
  const files = bundles.map((name) => ({
    name,
    signature: name.endsWith(".dmg") ? undefined : `sig of ${name}\n`,
  }));
  const manifest = buildManifest({
    version: v,
    notes: "Notes",
    pubDate: "2026-11-02T10:00:00.000Z",
    baseUrl: "https://github.com/o/r/releases/download/v1.0.0",
    files,
  });
  assert.equal(manifest.version, v);
  assert.equal(manifest.pub_date, "2026-11-02T10:00:00.000Z");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    "darwin-aarch64",
    "darwin-aarch64-app",
    "darwin-x86_64",
    "darwin-x86_64-app",
    "linux-x86_64",
    "linux-x86_64-appimage",
    "linux-x86_64-deb",
    "linux-x86_64-rpm",
    "windows-x86_64",
    "windows-x86_64-msi",
    "windows-x86_64-nsis",
  ]);
  assert.deepEqual(manifest.platforms["windows-x86_64"], {
    signature: `sig of DataLiq_${v}_x64-setup.exe`,
    url: `https://github.com/o/r/releases/download/v1.0.0/DataLiq_${v}_x64-setup.exe`,
  });
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    manifest.platforms["darwin-x86_64"].url,
    "one universal bundle for both Mac architectures",
  );
});

test("no signatures, no manifest; two bundles for one key is an error", () => {
  const base = { version: v, notes: "", pubDate: "", baseUrl: "u" };
  assert.equal(buildManifest({ ...base, files: bundles.map((name) => ({ name })) }), null);
  assert.throws(
    () =>
      buildManifest({
        ...base,
        files: [
          { name: `DataLiq_${v}_amd64.deb`, signature: "a" },
          { name: `DataLiq_${v}_amd64.deb`, signature: "b" },
        ],
      }),
    /two update bundles for linux-x86_64-deb/,
  );
});

test("checksums in sha256sum format, sorted by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "sums-"));
  writeFileSync(join(dir, "b"), "hello\n");
  writeFileSync(join(dir, "a"), "");
  assert.equal(
    sha256sums([
      { name: "b.deb", path: join(dir, "b") },
      { name: "a.msi", path: join(dir, "a") },
    ]),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  a.msi\n" +
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  b.deb\n",
  );
});

test("release notes are the version's CHANGELOG section", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [1.0.0] - 2026-11-02",
    "",
    "Big release.",
    "",
    "### Added",
    "",
    "- Things.",
    "",
    "## [0.6.0] - 2026-10-28",
    "",
    "Older.",
    "",
    "[1.0.0]: https://example.com",
  ].join("\n");
  assert.equal(releaseNotes(changelog, "1.0.0"), "Big release.\n\n### Added\n\n- Things.");
  assert.equal(releaseNotes(changelog, "0.6.0"), "Older.");
  assert.equal(releaseNotes(changelog, "2.0.0"), null);
});

test("the tag must name the app's version", () => {
  assert.equal(versionOfTag("v1.0.0", "1.0.0"), "1.0.0");
  assert.throws(() => versionOfTag("v1.0.1", "1.0.0"), /doesn't match the app version 1\.0\.0/);
});
