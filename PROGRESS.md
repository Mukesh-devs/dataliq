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

### Step 7 — Background import and cache ✅

- `cache/`: key = SHA-256 of (absolute path, size, mtime, import options); one DuckDB file +
  JSON meta per dataset in the OS cache dir; writes go to `.partial` and are renamed on
  success; stale partials removed at startup; LRU cleanup to `cacheMaxGb` (default 20) never
  touching open datasets; clear; free-space lookup.
- `import/`: `CREATE TABLE … AS SELECT * FROM read_csv(…)` on a raw DuckDB connection
  (`engine/raw.rs`, C API) so progress (`duckdb_query_progress`, bytes-based for CSV/.gz) can
  be polled and the import interrupted; gzip integrity check in parallel (`sources/integrity.rs`);
  attach read-only + register as a rowid-paged dataset; low-disk error with a "Read directly"
  fallback (LIMIT/OFFSET paging of the file); caching-off mode uses a session temp dir.
- Commands: `import_file` (emits `import-progress`), `cancel_import`, `open_direct`,
  `close_dataset`, `cache_info`, `clear_cache`, `get_settings`. Settings gain `cacheEnabled`,
  `cacheMaxGb`, `cacheDir`, `smallFileMb`.
- UI: import starts after the preview; progress bar with percent, elapsed time and Cancel
  (hidden for files < 100 MB); grid switches to the full dataset in place; failure/cancel
  bars with "Try again"/"Import again"/"Read directly"; status bar shows rows and
  "imported in …"/"from cache"; sidebar cache size with "Clear cache".
- Tested: cache unit tests (keys, commit/partials, LRU, free space); 10 import integration
  tests (reopen from cache < 1 s in a new session, edit → re-import, cancel leaves an empty
  cache dir and a later import works, progress events, truncated .gz → plain error and nothing
  cached, .gz = plain rows, caching off, LRU under limit, direct mode paging, low-disk message);
  gzip integrity unit test; Vitest (store import lifecycle, progress, cancel, low disk, reopen,
  close; ImportBar states); Playwright (progress → switch to full data; cancel keeps preview).
  Perf: 5 GB CSV import 31.9 s, 5 GB .csv.gz 98.5 s, reopen 1–2 ms, peak RSS 1.9/3.2 GB.
  Smoke (real app): progress bar during a 100 MB .csv.gz import, scroll position kept when the
  grid switched to 2,132,553 rows, "from cache" on reopen in a new app session.
- Left over: none for this step. (Filters/selection preservation applies once filters exist in v0.2.)

### Step 8 — JSON, NDJSON and Parquet ✅

- JSON/NDJSON via `read_json(?, format = 'auto' | 'newline_delimited', compression = ?)`
  (also `.gz`/`.zst`); imported like CSV. Nested STRUCT/LIST/MAP values show as compact JSON
  and open pretty-printed in the cell viewer (double-click/Enter).
- Parquet queried in place: `open_file` returns a dataset at once (row count from metadata),
  paged by `file_row_number` (`DatasetSource::Parquet`), no import or cache.
- Frontend formatting fixed for DECIMAL (scale) and TIME (unit); BigInts inside JSON stay numbers.
- Tested: 6 integration tests (JSON array, NDJSON, nested, .gz equals plain, JSON import keeps
  nested types, Parquet with 18 types, Parquet in-place paging); Vitest decodes and formats every
  recorded column type (incl. Parquet types) and checks the expected text; Playwright opens nested
  JSON and expands a value. Perf: 5 GB .ndjson.gz first rows 0.35 s, import 94.6 s (106M rows =
  manifest); 50M-row Parquet open 46 ms, 22.9 ms per random page. Smoke (real app): 50M-row
  Parquet "queried in place", Go to row 30,000,000 lands on the row.
- Fixed along the way: recording guard compares decoded Arrow (D20).
- Left over: none.

### Step 9 — Excel ✅

- `sources/excel.rs` (calamine 0.36): sheet list, default = first sheet with data, header row
  detection (skips title rows) or user choice (row N / none), unique non-empty column names,
  type inference per column, cached formula values, empty rows skipped; xlsx preview streams
  only the first rows; rows written with DuckDB's Appender (temp table for the preview, the
  cached database for the import, with progress and cancel).
- UI: Sheet picker and Header row choice in the file header; changing either re-opens and
  re-imports (each sheet/header choice is its own cache entry).
- Fixture: `fixtures/excel/legacy.xls` via `scripts/make_xls.py`.
- Tested: 5 integration tests (xlsx types/dates/formulas/empty row/blanks, title row skipped,
  header override and "no header", legacy .xls, missing/empty sheet errors, import + per-sheet
  cache entries) + unit tests (dates, header detection, names, inference); Vitest for the
  controls; Playwright opens the recorded xlsx and switches sheets. Perf: 1M-row xlsx preview
  0.054 s, import 14.9 s (peak 419 MB). Smoke (real app): multi_sheet.xlsx with picker,
  "4 rows · imported in 14 ms".
- Left over: none.

### Step 10 — Tabs and opening ✅

- Tabs: close button, middle-click close, busy spinner, Ctrl+W, Ctrl+Tab / Ctrl+Shift+Tab
  (wrapping), Ctrl+O; the Open dialog accepts several files.
- Recent files (10, newest first, persisted) in the empty state.
- Drag and drop via Tauri's webview drag-drop events (real paths): highlighted drop zone, or a
  "Drop to open in a new tab" overlay when files are open.
- CLI: `bigview <files>` (relative paths resolved, flags ignored, `--` supported) opens at
  startup (`take_startup_files`); single instance (tauri-plugin-single-instance): a second
  launch forwards its files (`open-files` event), focuses the window and exits.
- macOS File menu (Open…, Close Tab) — D22. Integration tests merged into one binary — D23.
- Fixed: when the grid's source switched from preview to the imported dataset with the same
  visible region, no pages were requested (blank cells); the grid now loads the visible rows on
  every source change and shows page-load errors instead of swallowing them.
- Tested: CLI parsing unit tests; Vitest (recent files, tabs cycle/close/multi-open, TabBar);
  Playwright (3 files: two from one dialog + Ctrl+O, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+W, close
  buttons, reopen from recent files; drag-and-drop states and drop; startup files and forwarded
  "open-files"; same-row-count import switch; two concurrent imports). Smoke (real app, Xvfb +
  D-Bus): `bigview comma.csv` opened at startup; `bigview semicolon.csv records.ndjson` from a
  second launch exited in 0.06 s and both files opened as tabs in the running app with rows.
- Left over: file associations are v1.0 (settings/installer).

### v0.1.0 release ✅

- Version test list: all Rust unit + integration tests, Vitest, Playwright UI flows, Tauri debug
  build; on-demand perf checks (`perf_preview`, `perf_import`, `paging`, `bench_small`,
  `pnpm e2e:perf`) on the generated fixtures.
- Added the small benchmark suite and regression guard (`pnpm bench`, `bench.yml`, D26) and a
  grid scroll check (`pnpm e2e:perf`); a `frontend ready` startup log for cold-start timing.
- Fixed: imports waited up to 250 ms for the progress thread to finish polling; a cancel that
  landed just before the import statement started (CI caught it) was ignored — now checked
  before and after, with a race test that fails without the fix. The v0.1.0 tag is on this fix.
- Measured (docs/BENCHMARKS.md): cold start 0.87 s to UI ready; idle memory 241 MiB PSS / 77 MiB
  private (budget missed on PSS, D25); .deb/.rpm 19.4 MB, AppImage 92.5 MB (D24); grid 60 fps
  with page waits under 80 ms.
- Done criteria: all formats open; previews meet the budget (5 GB CSV 0.30 s, .csv.gz 1.04–1.23
  s, .ndjson.gz 0.35 s); 50M rows scroll; installers build on all 3 OSes in CI.
- Left over: per-OS budgets on Windows/macOS and the AppImage/idle-memory items go to the v1.0
  performance pass; the Bench workflow's first run records the CI baseline.

## v0.2 — Explore

### Step 1 — ViewSpec and SQL builder ✅

- `ViewSpec` (filters, multi-column sort, global search, visible columns in order) shared with the
  UI as JSON; `view::build` turns it into a `SELECT` and a `count(*)` over any dataset (imported
  table, direct read, or Parquet in place) with every value bound and every identifier checked
  and quoted (D27).
- Filter ops: contains / starts with / ends with (case-insensitive by default), regex, empty,
  null / not null, equals, >, >=, <, <=, range (open ends), last N days, value list (with NULL),
  and `not` on any of them. Search covers text columns.
- Tested: insta snapshots of the generated SQL for every op, combined views, Parquet params, and
  column names with spaces, quotes, apostrophes, SQL keywords, unicode, emoji and `;--`; values
  never reach SQL text; plain errors for unknown columns; UI JSON round trip. Integration tests
  run every op in DuckDB on a table with awkward column names (and on Parquet in place) and check
  the exact rows, sort order (NULLS LAST) and that `count` agrees with `select`.
- Smoke: no UI yet (filters arrive in step 2); the app still starts and opens files as before.
- Left over: none.

### Step 2 — Column filters by type ✅

- Backend: `open_view` counts a ViewSpec and registers it as its own pageable dataset (a newer
  request per tab cancels the older); `column_values` lists a column's most common values with
  counts under the view's other filters, optionally searched. Views over imported tables, direct
  reads and Parquet in place.
- UI: filter editor per column type, opened from the column header menu / right-click or the
  toolbar's Filter button (searchable column list): text (contains, equals, starts/ends with,
  regex, empty), numbers (=, between, >, ≥, <, ≤), dates (between, before, after, on, last N
  days), booleans, null / not null, and "is one of" with a searchable value list and counts;
  "Exclude matching rows" negates (keeping NULLs). Filters show as chips (edit, remove, clear);
  filtered headers are highlighted; status bar shows "N of M rows · filtered in X ms". Filters
  chosen while importing apply when the import finishes.
- CSV `""` is now an empty string, not NULL (D28; cache format v2).
- Tested: `fixtures/csv/people.csv` (1,000 rows) with expected counts computed by parsing the file
  in Rust for every filter type and its negation, value lists and combinations; Vitest for the
  editor, chips, drafts and the store; Playwright for add / edit / remove / clear from the toolbar
  and header, value lists, and filters set during an import. Smoke (real app): right-click "city",
  type "par", Enter → "167 of 1,000 rows · filtered in 2 ms" (167 matches the CSV); a second
  boolean filter from the header with Enter.
- Left over: deep pages of a filtered view use LIMIT/OFFSET until step 3 materializes views.

### Step 3 — Multi-column sort with materialized view paging ✅

- Sort from the header: click sorts by a column (ascending → descending → off), Shift+click adds
  it as the next key; arrows (numbered for several keys) in the headers. The header menu (▼ or
  right-click) has sort ascending/descending, add to / remove from sort, and Filter…. Sort chips
  in the toolbar reverse or remove a key. Clearing the view cancels a sort still running.
- Views are written to a session-only scratch database (D29): a sorted view writes its first
  10,000 rows at once (~1 s on 50M rows), then its last 10,000 and the full sort in the
  background, switching over transparently; filter-only views are counted at once and written
  out in the background. Stable paging (rowid ranges on the written table; ties in file order).
  Closing a view drops its tables; a newer view in the tab cancels an older one.
- Merged v0.1.0 + steps 1–2 into `main` (mukesh-dsnl/dataliq#1, merge commit).
- Tested: integration tests for exact order (NULLs last, stable ties) on people.csv, multi-key
  sorts with filters, head/tail/middle paging on 30,000 rows (middle waits for the full sort),
  background materialization, cleanup and cancellation, Parquet in place; unit tests for the
  reversed order; Vitest for sort toggling, the column menu, sort chips and the store (view-ready,
  cancelling); Playwright for header click / Shift+click / chips / column menu. Perf: see
  docs/BENCHMARKS.md (filter budget met; full 50M sort 20–37 s in the background, first rows ~1 s).
- Left over: none for this step.
