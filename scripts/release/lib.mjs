// Pure helpers for the release workflow (.github/workflows/release.yml):
// which bundle files are released, the updater manifest (latest.json, D51),
// checksums and release notes. Tested by release.test.mjs.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * What a bundle file is, from its name as Tauri writes it, or null if it is
 * not released. `updater` lists the updater platform keys it serves (when it
 * has a signature): `{os}-{arch}` and `{os}-{arch}-{bundle type}`.
 */
export function classify(name) {
  const rules = [
    [/_x64-setup\.exe$/, "Windows installer", ["windows-x86_64", "windows-x86_64-nsis"]],
    [/_x64_[\w-]+\.msi$/, "Windows MSI package", ["windows-x86_64-msi"]],
    [/_aarch64\.dmg$/, "macOS disk image (Apple silicon)", []],
    [/_x64\.dmg$/, "macOS disk image (Intel)", []],
    [
      /_aarch64\.app\.tar\.gz$/,
      "macOS update bundle (Apple silicon)",
      ["darwin-aarch64", "darwin-aarch64-app"],
    ],
    [/_x64\.app\.tar\.gz$/, "macOS update bundle (Intel)", ["darwin-x86_64", "darwin-x86_64-app"]],
    [/_amd64\.AppImage$/, "Linux AppImage", ["linux-x86_64", "linux-x86_64-appimage"]],
    [/_amd64\.deb$/, "Debian/Ubuntu package", ["linux-x86_64-deb"]],
    [/\.x86_64\.rpm$/, "Fedora/openSUSE package", ["linux-x86_64-rpm"]],
  ];
  for (const [pattern, kind, updater] of rules) {
    if (pattern.test(name)) return { kind, updater };
  }
  return null;
}

/**
 * The name a bundle is released under. Tauri names the macOS update bundle
 * `DataLiq.app.tar.gz` with no version or architecture; give it both, like
 * the others (`arch`: "aarch64" or "x64", as in the .dmg names).
 */
export function releaseName(name, version, arch) {
  return name.endsWith(".app.tar.gz") && !name.includes(version)
    ? name.replace(/\.app\.tar\.gz$/, `_${version}_${arch}.app.tar.gz`)
    : name;
}

/** The Mac architecture of a bundle folder (`target/<triple>/release/bundle`), or null. */
export function macArch(bundleDir) {
  const match = /(aarch64|x86_64)-apple-darwin/.exec(bundleDir);
  if (!match) return null;
  return match[1] === "aarch64" ? "aarch64" : "x64";
}

/**
 * The updater manifest for the files released with their signatures:
 * `files` is [{ name, signature? }], released at `baseUrl`/name.
 * Null when nothing is signed (a build without the update key).
 */
export function buildManifest({ version, notes, pubDate, baseUrl, files }) {
  const platforms = {};
  for (const { name, signature } of files) {
    const info = classify(name);
    if (!info || !signature) continue;
    for (const key of info.updater) {
      if (platforms[key]) throw new Error(`two update bundles for ${key}: ${name}`);
      platforms[key] = {
        signature: signature.trim(),
        url: `${baseUrl}/${encodeURIComponent(name)}`,
      };
    }
  }
  if (Object.keys(platforms).length === 0) return null;
  return { version, notes, pub_date: pubDate, platforms };
}

/** `sha256sum`-style lines for `files` ([{ name, path }]), sorted by name. */
export function sha256sums(files) {
  return [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, path }) => {
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      return `${hash}  ${name}\n`;
    })
    .join("");
}

/** The CHANGELOG section of `version` (without its heading), or null. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## \[/.test(l) || /^\[[^\]]+\]: /.test(l));
  return rest
    .slice(0, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** The version a tag names (`v1.2.3` → `1.2.3`), checked against the app's. */
export function versionOfTag(tag, appVersion) {
  const version = tag.replace(/^v/, "");
  if (version !== appVersion) {
    throw new Error(
      `The tag ${tag} doesn't match the app version ${appVersion} (package.json, tauri.conf.json).`,
    );
  }
  return version;
}
