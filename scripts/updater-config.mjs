#!/usr/bin/env node
// Writes the Tauri config overlay that turns on app updates (D51):
//
//   BIGVIEW_UPDATER_PUBKEY=<public key> node scripts/updater-config.mjs <out.json>
//   pnpm tauri build --config <out.json>
//
// The overlay adds the updater's public key and manifest URL, and makes the
// build sign its update bundles (the private key comes from the
// TAURI_SIGNING_PRIVATE_KEY environment variable, never from the repo).
// Builds without it have no updater and say so in Help › Check for updates.
//
// BIGVIEW_UPDATER_ENDPOINT overrides the manifest URL; by default it is the
// `latest.json` of the latest GitHub release of $GITHUB_REPOSITORY.

import { writeFileSync } from "node:fs";

const out = process.argv[2];
const pubkey = process.env.BIGVIEW_UPDATER_PUBKEY?.trim();
const repo = process.env.GITHUB_REPOSITORY ?? "mukesh-dsnl/dataliq";
const endpoint =
  process.env.BIGVIEW_UPDATER_ENDPOINT ??
  `https://github.com/${repo}/releases/latest/download/latest.json`;

if (!out || !pubkey) {
  console.error("usage: BIGVIEW_UPDATER_PUBKEY=<key> node scripts/updater-config.mjs <out.json>");
  process.exit(2);
}

const url = new URL(endpoint);
// Plain HTTP only for a manifest served on this computer (testing).
const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
if (url.protocol !== "https:" && !local) {
  console.error(`The update manifest must be served over HTTPS: ${endpoint}`);
  process.exit(2);
}

const overlay = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey,
      endpoints: [endpoint],
      // An update must be signed for the version the manifest announces, so
      // an older (genuinely signed) build can't be passed off as a new one.
      requireSignedVersion: true,
      ...(local ? { dangerousInsecureTransportProtocol: true } : {}),
      windows: { installMode: "passive" },
    },
  },
};
writeFileSync(out, `${JSON.stringify(overlay, null, 2)}\n`);
console.log(`Updater config written to ${out} (manifest: ${endpoint})`);
