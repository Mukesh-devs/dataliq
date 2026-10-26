# Progress

Tracks each step of [BUILD_PLAN.md](BUILD_PLAN.md): what was done, how it was
tested, and anything left over.

## v0.1 — Core viewer

### Step 1 — Scaffold ✅

- Tauri v2 (2.12) + React 18 + TypeScript 6 (strict) + Vite 8 + Tailwind CSS 4.
- Cargo workspace at the repo root with the app crate in `src-tauri/`.
- `scripts/check.sh` / `scripts/check.ps1`, `scripts/smoke.sh` (Linux screenshot smoke check).
- CI (`.github/workflows/ci.yml`): checks + `tauri build --debug` on Ubuntu, macOS, Windows.
- Docs: README, CHANGELOG, CONTRIBUTING, LICENSE (MIT), docs/ARCHITECTURE, DECISIONS, BENCHMARKS.
- Tested: Vitest render test; `scripts/check.sh` passes locally (Linux); smoke check —
  the debug binary opens a 1280×800 window showing "BigView" (Xvfb screenshot).
- Left over: none.

### Step 2 — Design system and app shell ✅

- Design tokens as CSS variables (`src/styles/tokens.css`) mapped to Tailwind utilities;
  light and dark themes, following the OS by default; compact/comfortable density.
- Inter + JetBrains Mono bundled from `@fontsource-variable` (no CDN).
- Layout: tab bar (+ open button, search / Ctrl+K box), sidebar (Files, Columns),
  main area, status bar with theme toggle. Empty state: drop zone + recent files.
- Tested: Vitest render tests (layout regions, empty state, theme switching, density,
  shortcut formatting, settings store); Playwright screenshots of both themes plus a
  theme-persistence flow. Smoke check: the debug app window shows the shell with the
  bundled fonts under the strict CSP.
- Left over: drag-and-drop and Open are wired up in step 10 (Tabs and opening).

### Step 3 — DuckDB engine ✅

- `engine::Engine`: in-memory DuckDB (bundled, with json + parquet compiled in, extension
  auto-install/auto-load off), memory limit (default 50% RAM) and spill dir from
  `settings.json` (OS config dir, written with defaults on first start), one connection per
  query, request registry with cancel-by-id and "newer request in a group wins".
- Commands `run_query` (returns raw Arrow IPC via `tauri::ipc::Response`, capped at 100k rows)
  and `cancel_query`; per-command permissions in `capabilities/default.json`.
- Frontend: `src/lib/arrow.ts` (decode + type mapping), `src/lib/ipc.ts` (typed `invoke`,
  `BigViewError`), status bar shows the DuckDB version via a real Arrow round trip.
- Logging with `tracing` to stderr and a daily-rolling file in the app log dir.
- Tested: 10 engine integration tests (types/values of a known query, IPC round trip vs a
  committed fixture, empty results keep schema, bound parameters, row cap, memory/temp/thread
  settings, offline JSON+Parquet, plain error messages, cancel by id, group cancel) + unit
  tests for settings/errors/params; Vitest decodes the Rust-written IPC fixture and tests the
  engine store with mocked IPC. Benchmark: 0.58 ms per 1,000-row page (docs/BENCHMARKS.md).
  Smoke check: app status bar shows "Ready · DuckDB v1.5.6"; settings.json and log file created.
- Left over: none.

### Step 4 — Test fixtures ✅

- 26 small committed fixtures in `fixtures/` (see `fixtures/README.md`): delimiters, quoting,
  BOM, Latin-1, NULL vs empty, mixed types, date formats, header-only, empty, bad rows,
  500 columns, JSON array / NDJSON / nested, Parquet with many types, multi-sheet .xlsx,
  `.gz` twins and a truncated `.gz`. `.xls` is added with the Excel step (needs a BIFF writer).
- `scripts/gen_fixtures` (Rust crate, workspace member): deterministic seeded generator for
  the large git-ignored set — `pnpm fixtures small|large|verify|list|committed`. Writes
  `fixtures/generated/manifest.json` (rows, bytes, SHA-256, id sum).
- Tested: 8 generator tests (pinned SHA-256 of a 1,000-row CSV, determinism, byte-size
  targets for plain and gzip output, gzip == plain content, NDJSON/Parquet/XLSX row counts
  via DuckDB, committed fixtures up to date). Smoke: `pnpm fixtures small` generates the
  100 MB set in 10 s and `verify` passes.
- Left over: large set is generated on demand (needs ~17 GB of disk).

### Step 5 — CSV/TSV and .gz ✅

- `sources/detect.rs`: format + compression from extension (incl. `.csv.gz`, `.ndjson.zst`)
  and magic bytes (gzip, zstd, Parquet, zip/xlsx, OLE/xls); content sniffing for unknown names.
- `sources/csv.rs`: `CsvOptions` (delimiter, header, quote, escape, encoding, skip rows,
  ignore bad rows, date/timestamp format) → bound `read_csv(?, …)` / `sniff_csv(?, …)` calls.
- `sources/mod.rs`: `Source` (inspect = sniff + DESCRIBE + reader SQL, preview = first 1,000
  rows as Arrow), delimiter fallback + first-bad-line diagnosis, friendly errors.
- Commands `open_file`, `preview_file`; dialog plugin for Open file (`dialog:allow-open`).
- UI: tabs store opens files (info + preview in parallel), file header with format badge,
  Import settings popover (detected values as hints), temporary preview table (replaced by
  the grid in step 6), NULL vs empty string shown differently, status bar timing.
- Tested: 19 CSV integration tests over every CSV fixture (delimiters, quoting, BOM, Latin-1,
  NULL vs empty, mixed types, date formats, header-only, empty, bad rows + ignore, 500 columns,
  `.gz` twins equal plain, gzip without extension, `.zst`, truncated `.gz`, overrides, paths
  with spaces/quotes/unicode, missing file); unit tests for detection, option building,
  validation, error messages; Vitest for tabs store, Import settings, FileView, formatting;
  Playwright flows (open from dialog, Import settings apply, plain errors) on recorded backend
  responses. Budgets: 5 GB CSV first rows 0.30 s (< 1 s), 5 GB .csv.gz 1.23 s (< 2 s).
  Smoke (real app, Xvfb + xdotool): opened semicolon.csv via the native dialog (31 ms) and the
  5 GB .csv.gz (1,000 rows in 1.04 s); Import settings popover shows detected values.
- Fixed along the way: `Button` now forwards refs (Radix popovers could not position).
- Left over: truncated-gzip detection happens in the full import (step 7, see D12).

### Step 6 — Data grid ✅

- Glide Data Grid (`src/components/grid/DataGrid.tsx`) over a `RowSource`:
  `StaticRowSource` (preview) or `PagedRowSource` (backend pages of 500 rows, LRU of 64
  pages, de-duplicated requests, prefetch one page each side, redraws only affected cells).
- Type-aware cells (`cells.ts`): numbers right-aligned and exact (BigInt), booleans as
  checkboxes, dates/timestamps formatted, NULL as faded italic `null`, empty string as faded
  `""`, long text truncated for display but copied in full. Header type icons, theme from the
  CSS tokens (light/dark), density-aware row height, row numbers, column resize, range
  selection, copy as TSV (pages loaded on demand for copy).
- Backend: dataset registry + `fetch_rows(datasetId, start, count)` paging by rowid ranges
  with bound parameters (`engine/datasets.rs`), `quote_ident` helper (`engine/sql.rs`).
- Go to row (Ctrl+G) with a proportional scroll mapping (`scrollToRow.ts`) — Glide's own
  `scrollTo` is wrong beyond the browser's ~33M px height cap.
- Tested: row-source unit tests (LRU, de-dupe, last page, errors, 50M-row stride scroll),
  cell mapping, scroll mapping; Rust paging tests (exact pages at start/middle/end, partial
  last page, cap, unknown dataset) + 50M-row on-demand test (6.3 ms per random page);
  Playwright on a mocked 50M-row dataset: first rows, wheel-scroll top to bottom with no
  errors and the last row loaded, go to row 25,000,000, copy a range as TSV.
  Smoke (real app): 5 GB .csv.gz preview in the canvas grid, scrolling and range selection.
- Left over: the full dataset (and thus paging in the real app) arrives with step 7's import;
  column header mini-histograms are v0.2.
