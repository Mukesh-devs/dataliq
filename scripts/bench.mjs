#!/usr/bin/env node
// Small benchmark suite + regression guard.
//
//   node scripts/bench.mjs            generate the 100 MB fixtures, run the suite,
//                                     compare with bench/baseline/<os>.json
//   node scripts/bench.mjs --update   same, then write the results as the baseline
//
// Fails when a flow is more than 30% slower than its baseline (and at least
// MIN_SLOWDOWN_MS slower, so sub-millisecond flows don't trip on noise).
// Without a baseline for this OS it only reports, so a new runner can record one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SLOWDOWN = 0.3;
const MIN_SLOWDOWN_MS = 5;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const os =
  { linux: "linux", darwin: "macos", win32: "windows" }[process.platform] ?? process.platform;
const baselinePath = join(root, "bench", "baseline", `${os}.json`);
const outDir = join(root, "target", "bench");
const outPath = join(outDir, `${os}.json`);
const update = process.argv.includes("--update");

const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

mkdirSync(outDir, { recursive: true });
run("cargo", ["run", "--quiet", "-p", "gen_fixtures", "--", "small"]);
run(
  "cargo",
  ["test", "-p", "bigview", "--test", "it", "bench_small", "--", "--ignored", "--nocapture"],
  { BENCH_OUT: outPath },
);

const results = JSON.parse(readFileSync(outPath, "utf8"));
if (update) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Baseline written to ${baselinePath}`);
  process.exit(0);
}
if (!existsSync(baselinePath)) {
  console.log(`No baseline for ${os} (${baselinePath}); results are in ${outPath}.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const rows = [];
let failed = false;
for (const [flow, ms] of Object.entries(results)) {
  const base = baseline[flow];
  if (base === undefined) {
    rows.push({ flow, ms, base: "—", change: "new" });
    continue;
  }
  const change = (ms - base) / base;
  const regressed = change > MAX_SLOWDOWN && ms - base > MIN_SLOWDOWN_MS;
  failed ||= regressed;
  rows.push({
    flow,
    ms,
    base,
    change: `${change >= 0 ? "+" : ""}${(change * 100).toFixed(0)}%${regressed ? "  REGRESSION" : ""}`,
  });
}
console.table(rows);
if (failed) {
  console.error(`A flow got more than ${MAX_SLOWDOWN * 100}% slower than ${baselinePath}.`);
  process.exit(1);
}
