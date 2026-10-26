# Design decisions

Deviations from, or clarifications of, `BUILD_PLAN.md`, with the reasoning.

## D1 — Repository root is the project root

The plan shows a `bigview/` folder. This repository *is* the project, so
`src-tauri/`, `src/`, `scripts/` etc. live at the repo root. A Cargo workspace
at the root lets `cargo fmt/clippy/test` run from the root as the check script
expects.

## D2 — Dependency versions

Pinned to the newest stable releases that were at least two weeks old when the
project started (2026-10-26), with these exceptions:

- **React 18.3.1, not 19.** The data grid (`@glideapps/glide-data-grid` 6.0.3,
  its latest stable) declares React `16–18` as its peer range. Only an alpha
  supports React 19. The grid is the core of the app, so we stay on React 18
  until a stable grid release supports 19.
- **TypeScript 6.0.3, not 7.** `typescript-eslint` 8.71 supports TypeScript
  `< 6.1`. TypeScript 7 (the native port) is not yet supported by the lint stack.

## D3 — License: MIT

The plan allows Apache-2.0 or MIT. MIT is the shortest and the most common in
the Tauri ecosystem.

## D4 — Optimized dependencies in debug builds

`[profile.dev.package."*"] opt-level = 2` in the root `Cargo.toml`. DuckDB is
compiled from bundled C++ and is far too slow unoptimized; this keeps
`cargo test` and `tauri build --debug` usable without changing our own crate's
debug experience.

## D5 — Playwright UI flows run on Linux only

UI flows run against the Vite dev server in Chromium with Tauri IPC mocked, so
they test our frontend, not the OS webview. Screenshot baselines depend on font
rasterization, which differs per OS; baselines are rendered on Ubuntu 24.04 and
the e2e CI job runs there only. Native builds are still checked on all 3 OSes.
`@playwright/test` is pinned to 1.63.0 to match the Chromium build available in
the development container.

## D6 — UI settings persisted in local storage (for now)

Theme and density live in a Zustand store persisted to the webview's local
storage. Backend settings (memory limit, cache) use a JSON settings file from
step 3; UI settings move there when the settings screen arrives.

## D7 — `query_arrow` (materialized) instead of `stream_arrow`

The duckdb crate's Arrow iterators **panic** if fetching a chunk fails, and a
streaming fetch can fail mid-way (for example after a cancel). We use
`Statement::query_arrow`, which executes the whole statement before the
iterator starts, so errors and interrupts surface as `Result`s. This is safe
because every query the UI runs is bounded: grid pages and previews use
`LIMIT`, and user SQL results (v0.3) are materialized into a temp table and
paged. `run_query` also caps responses at 100,000 rows.

## D8 — Parameters inside table functions

User values (including file paths) are bound as parameters even inside table
functions, e.g. `read_csv(?, delim = ?)`. DuckDB re-binds such prepared
statements at execution time; this is covered by the engine tests.

## D9 — No debug info for dependencies

DuckDB's bundled C++ build produces ~6 GB of debug info per build
configuration. `[profile.dev.package."*"] debug = false` keeps `target/` small;
our own crate keeps full debug info.

## D10 — `.zst` support

DuckDB reads `.zst` CSV/JSON through the zstd file system registered by its
Parquet extension, which we compile in. So `.csv.zst`, `.tsv.zst`,
`.json.zst` and `.ndjson.zst` are supported in addition to `.gz`.

## D11 — Fixture generator written in Rust

`scripts/gen_fixtures` is a Rust crate rather than a Python script: it reuses
DuckDB (Parquet) and rust_xlsxwriter (Excel) with no extra toolchain, and works
the same on all 3 OSes. Text output uses an in-crate SplitMix64 PRNG so files are
byte-identical everywhere; a test pins the SHA-256 of a small sample.

## D12 — Truncated .gz files

DuckDB treats an unexpected end of a gzip stream as the end of the data
(`CompressedFile::ReadData` stops when the underlying file returns 0 bytes), so
a truncated `.gz` reads "successfully" with missing rows. The preview shows the
readable rows; the full import (v0.1 step 7) runs our own gzip integrity check
(`flate2`, which validates the stream end and CRC) alongside DuckDB and reports
"This compressed file looks damaged or incomplete" instead of silently
caching partial data.

## D13 — Delimiter fallback when one row is bad

DuckDB's sniffer requires every sampled row to have the same column count; one
bad row makes it fall back to a single text column. When auto-detection yields
a single column whose header contains `,` `;` tab or `|`, we retry with that
delimiter. The read then fails on the real problem, and we locate the first bad
line with DuckDB's `store_rejects` tables over the sniffer sample, giving
"Line 7 has 4 columns, expected 3. Try "Ignore bad rows" in Import settings."
Messages say "Line" (file line numbers) rather than "Row".

## D14 — UI flows replay recorded backend responses

`e2e/tauri-mock.ts` installs a fake `window.__TAURI_INTERNALS__` and replays
responses recorded from the real backend (`e2e/recordings/backend.json`,
written by `src-tauri/tests/ui_recordings.rs`). A normal `cargo test` fails if
the recordings drift from what the backend returns.

## D15 — Playwright runs against the production bundle

The plan says UI flows run against the Vite dev server. Glide Data Grid's
`useDebouncedMemo` sets a `mountedRef` to false in an effect cleanup and never
resets it, so under React StrictMode's dev-only double mount the grid's
accessible cell mirror (`role="gridcell"`) never renders. Production builds
are unaffected. Playwright therefore runs `vite build` + `vite preview`, which
also tests the bundle that ships.

## D16 — Go to row bypasses Glide's `scrollTo`

Browsers cap element heights at ~33M px; 50M rows × 28 px is 1.4B px. Glide
compensates by mapping scroll positions proportionally after big jumps, but
its own `scrollTo` (and scroll-to-selected-cell) adds a relative delta that the
mapping then misreads, landing at the end of the table. `scrollToRow.ts`
computes the real scrollTop for the wanted virtual position, and the cell is
selected only after the jump has rendered.
