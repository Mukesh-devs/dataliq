#!/usr/bin/env node
// Puts the files collected from every OS together for a release:
//
//   node scripts/release/finish.mjs <collected folder> <out folder> <tag> <owner/repo>
//
// Writes into <out folder>: the installers, latest.json (the updater manifest,
// when the builds were signed for updates), SHA256SUMS.txt over all of them,
// and notes.md (the version's CHANGELOG section) for the release text.

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, classify, releaseNotes, sha256sums, versionOfTag } from "./lib.mjs";

const [collected, outDir, tag, repo] = process.argv.slice(2);
if (!collected || !outDir || !tag || !repo) {
  console.error(
    "usage: node scripts/release/finish.mjs <collected folder> <out folder> <tag> <owner/repo>",
  );
  process.exit(2);
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
let version;
try {
  version = versionOfTag(tag, appVersion);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Every file of every OS's artifact folder.
const files = [];
for (const dir of readdirSync(collected)) {
  const sub = join(collected, dir);
  if (!statSync(sub).isDirectory()) continue;
  for (const name of readdirSync(sub)) {
    if (!name.endsWith(".sig") && classify(name)) files.push({ name, path: join(sub, name) });
  }
}
if (files.length === 0) {
  console.error(`No release files under ${collected}.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const released = files.map(({ name, path }) => {
  const target = join(outDir, name);
  copyFileSync(path, target);
  let signature;
  try {
    signature = readFileSync(`${path}.sig`, "utf8");
  } catch {
    signature = undefined;
  }
  return { name, path: target, signature };
});

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const notes = releaseNotes(changelog, version) ?? "See CHANGELOG.md.";
const manifest = buildManifest({
  version,
  notes,
  pubDate: new Date().toISOString(),
  baseUrl: `https://github.com/${repo}/releases/download/${tag}`,
  files: released,
});
const sums = [...released];
if (manifest) {
  const path = join(outDir, "latest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  sums.push({ name: "latest.json", path });
  console.log(`latest.json: ${Object.keys(manifest.platforms).join(", ")}`);
} else {
  console.log("No update signatures: no latest.json (the updater stays off for this release).");
}
writeFileSync(join(outDir, "SHA256SUMS.txt"), sha256sums(sums));

const list = released
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(({ name }) => `- \`${name}\` — ${classify(name).kind}`)
  .join("\n");
writeFileSync(
  join(outDir, "notes.md"),
  `${notes}\n\n### Downloads\n\n${list}\n\nCheck a download against \`SHA256SUMS.txt\`: ` +
    "`sha256sum -c SHA256SUMS.txt --ignore-missing` (Linux), " +
    "`shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (macOS), or " +
    "`Get-FileHash <file>` (Windows PowerShell).\n",
);
console.log(`${released.length} files, SHA256SUMS.txt and notes.md in ${outDir}`);
