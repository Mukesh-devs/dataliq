#!/usr/bin/env node
// Copies one build's release files out of Tauri's bundle folder:
//
//   node scripts/release/collect.mjs <bundle folder> <out folder> <version>
//
// Installers keep their names (the macOS update bundle gets the version);
// each update bundle's `.sig` comes along, for latest.json.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { classify, releaseName } from "./lib.mjs";

const [bundleDir, outDir, version] = process.argv.slice(2);
if (!bundleDir || !outDir || !version) {
  console.error("usage: node scripts/release/collect.mjs <bundle folder> <out folder> <version>");
  process.exit(2);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    // .app folders and AppDir trees are build inputs, not release files.
    if (statSync(path).isDirectory()) {
      if (!/\.(app|AppDir)$/.test(entry)) yield* walk(path);
    } else yield path;
  }
}

mkdirSync(outDir, { recursive: true });
let count = 0;
for (const path of walk(bundleDir)) {
  const name = basename(path);
  const info = classify(name);
  // Only this version's files (a local bundle folder keeps older ones); the
  // macOS update bundle is the one without a version in its name.
  const thisVersion =
    name.includes(`_${version}_`) || name.includes(`-${version}-`) || name === "DataLiq.app.tar.gz";
  if (!info || !thisVersion) continue;
  const target = releaseName(name, version);
  copyFileSync(path, join(outDir, target));
  if (existsSync(`${path}.sig`)) copyFileSync(`${path}.sig`, join(outDir, `${target}.sig`));
  console.log(
    `${target} — ${info.kind}${existsSync(`${path}.sig`) ? " (signed for updates)" : ""}`,
  );
  count += 1;
}
if (count === 0) {
  console.error(`No release files in ${bundleDir}.`);
  process.exit(1);
}
