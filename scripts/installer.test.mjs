// The Windows installer's hook (src-tauri/windows/hooks.nsh) and the file
// types in tauri.conf.json must agree: DataLiq is the default only for its
// own types, and listed under "Open with" for the common ones.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const hooks = readFileSync(join(root, "src-tauri", "windows", "hooks.nsh"), "utf8");

/** The DataLiq's own file types (it is their default program). */
const OWN = new Set(["Parquet data", "DuckDB database", "DataLiq workspace"]);

/** `[ext, class]` pairs listed in one of the hook's macros. */
function listed(macro) {
  const body = hooks.split(`!macro ${macro} DO`)[1]?.split("!macroend")[0] ?? "";
  return [...body.matchAll(/\$\{DO\} "([^"]+)" "([^"]+)"/g)].map((m) => [m[1], m[2]]);
}

test("the installer runs DataLiq's hook", () => {
  const path = conf.bundle.windows.nsis.installerHooks;
  assert.equal(path, "windows/hooks.nsh");
  assert.ok(existsSync(join(root, "src-tauri", path)));
  assert.match(hooks, /!macro NSIS_HOOK_POSTINSTALL/);
  assert.match(hooks, /!macro NSIS_HOOK_POSTUNINSTALL/);
});

test("every file type is either DataLiq's own or 'Open with' only, as in the config", () => {
  const common = [];
  const own = [];
  for (const a of conf.bundle.fileAssociations)
    for (const ext of a.ext) (OWN.has(a.name) ? own : common).push([ext, a.name]);
  const sort = (l) => [...l].sort((x, y) => x[0].localeCompare(y[0]));
  assert.deepEqual(sort(listed("DATALIQ_COMMON_TYPES")), sort(common));
  assert.deepEqual(sort(listed("DATALIQ_OWN_TYPES")), sort(own));
});

test("on macOS DataLiq is never picked first for the common types", () => {
  for (const a of conf.bundle.fileAssociations) {
    if (OWN.has(a.name)) assert.notEqual(a.rank, "Alternate", a.name);
    else assert.equal(a.rank, "Alternate", a.name);
  }
});
