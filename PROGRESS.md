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
- Smoke (real app, people.csv): clicking "amount" twice → "1,000 of 1,000 rows · sorted in 5 ms"
  with 998.5, 998.18, … at the top, ↓ in the header and an "amount ↓" chip; Shift+click "city"
  added a second key (↓1 / ↑2, chips "1. amount" "2. city"). Found and fixed: a sort click also
  selected the column.
- Left over: none for this step.

### Step 4 — Global search with highlighted matches ✅

- Search box at the right of the toolbar (Ctrl+F focuses it): rows where any text column contains
  the text, case-insensitively, combined with filters and sort (`ViewSpec.search`, bound as a
  parameter; LIKE wildcards and quotes are literal). Debounced typing, Enter searches at once,
  Escape / × clears. Matches are highlighted behind the text in text cells (a `--match` token per
  theme), never in null / "" markers, numbers or dates.
- Tested: Rust (people.csv: case, unicode, apostrophes, `%` `_` `'` `"` `\` literal, numbers and
  dates not searched, search + filter); Vitest (match finding incl. Unicode lower-casing that
  changes length, painting offsets, the search box's debounce / Enter / Escape); Playwright
  (Ctrl+F, one request after typing, search + filter, Escape keeps the filter).
- Smoke (real app, people.csv): Ctrl+F, "smith" → "300 of 1,000 rows · filtered in 12 ms" (300
  matches the file), "smith"/"Smith" highlighted in the name column only.
- Left over: none.

### Step 5 — Column management ✅

- Per-tab column layout (`src/lib/layout.ts`): display order, hidden and pinned columns, display
  names, widths. Display only: filters, sorting and SQL keep the real names; the grid maps shown
  columns to the data without re-querying. Reset when import settings change the columns.
- Header menu: Pin to the left / Unpin, Hide column (never the last one), Rename… (popover with
  Reset), Auto-fit width (header + rows on screen, 50–500 px). Drag a header to move it; dropping
  into the pinned block pins it (Glide `freezeColumns`). Sidebar "Columns": every column in
  display order with a show/hide checkbox, pin marker, "N of M shown" and Show all.
- Tested: Vitest for the layout model (hidden columns keep their place, pin order, drag in/out of
  the pinned block, reconcile with new columns, width limits, fit width), the menu items, rename
  popover and sidebar list; Playwright for hide from the menu / show from the sidebar / Show
  all, pin, rename, dragging a header and auto-fit.
- Smoke (real app, people.csv): pinned "amount" from its menu → first column, pin marker in the
  sidebar; Auto-fit on "name" narrowed it to fit "O'Neil Nakamura".
- Left over: none.

### Step 6 — Column profile ✅

- `column_profile` (Rust, `src-tauri/src/view/profile.rs`): over the view's filters and search
  (not its sort), one aggregate query (rows, nulls, distinct — exact up to 10M rows, HyperLogLog
  above, shown with "≈" — min, max, mean, std dev), a histogram (20 equal bars, or one bar per
  value for small integer ranges; dates and timestamps binned by epoch seconds) and the 10 most
  common values. Cancellable per tab (`profile:<tab>` group). D30 explains why not `SUMMARIZE`.
- Side panel from the header menu ("Column profile"): stats, distribution with edges formatted by
  type, most common values with share bars; follows filter and search changes, keeps the last
  result on screen while the next loads.
- Header mini-histograms for every number, date and boolean column (`column_histograms`: one scan
  for all ranges, then one per column), drawn under the titles through Glide's `drawHeader`;
  headers grow to 46 px. Toggle in the status bar (persisted).
- 50M rows: profiles 0.4–2.8 s per column (budget < 3 s, met), header histograms 4.0 s for 7
  columns in the background. Grouping top values by the typed value instead of its text took a
  near-unique timestamp from 7.5 s to 2.8 s.
- Tested: Rust against statistics computed independently from people.csv (counts, nulls, exact
  distinct, min/max/mean/std dev, histogram bars with the same edges, top values with ties, with
  filters, booleans, dates, all-null and empty views, edge cases of the header query); Vitest
  for value formatting, the panel and the header bar geometry; Playwright for the header charts
  (screenshots with and without), the toggle, and a profile that follows a new filter.
- Smoke (real app, people.csv): bars under id, amount, joined and active; "Column profile" on
  amount → 1,000 rows, 20 nulls (2.0%), 974 distinct, −98.46 … 998.5, mean 454.8815, 19 ms.
- Left over: none.

### Step 7 — Productivity ✅

- Command palette (Ctrl+K, or the search box in the tab bar): every action — open, recent files,
  tabs, theme, header histograms, clear cache, search, go to row, clear filters/sort/search,
  show all columns, filter / sort / profile any column, copy as …, copy view as SQL, cancel —
  found by words in any order, run with Enter; shortcuts shown next to them. Components register
  their commands while mounted (`stores/commands.ts`).
- Copy selection as CSV, TSV, JSON, Markdown table or SQL INSERT (Shift+Ctrl+C opens the palette
  on "Copy "): shown columns with display names, typed JSON values, typed SQL literals; rows read
  through the page cache in 5,000-row chunks, up to 100,000 rows (D31). Ctrl+C still copies TSV.
- Copy view as SQL (`view_sql`): the view over the file's own reader call with every value
  inlined, display names as aliases and a file-order tiebreak for sorts; Excel through DuckDB's
  `read_xlsx` (D31). Runs as-is in plain DuckDB.
- Cancel in the status bar while a view runs (back to the rows on screen) and "Stop sorting"
  while a sort finishes in the background (keeps filters). Status bar timings: preview, import,
  filter/sort ("first rows in …", "sorted in …"), and notices such as "Copied 2 rows as CSV".
- Tested: Rust — the copied SQL run in a fresh DuckDB matches the app's view value for value
  (filters of every kind, search, ties in sorts, chosen columns), display-name aliases, `?`
  inside quoted text, and (on demand, downloads the extension) the Excel reader against the
  import; Vitest — every copy format, chunked row reading, command matching and registration,
  the palette's keyboard use, status bar notices and the cancel button, the store's cancel rules;
  Playwright — palette sort, copy as Markdown/JSON from a selection, copy view as SQL, cancel.
- Smoke (real app, people.csv): Ctrl+K → "sort by amount desc" → Enter sorted the grid; "view as
  sql" copied a query that plain DuckDB ran with the same first rows (971, 58, 883).
- Left over: none.

### v0.2.0 release ✅

- Version test list: all Rust unit + integration tests (incl. the copied-SQL equivalence tests),
  Vitest, Playwright flows (filters, sort, search, columns, profile, palette, copy, cancel),
  Tauri debug build; on demand: `perf_views_50m`, `perf_profile_50m`, `perf_sort_strategies`,
  `excel_reader_sql_reads_the_same_table_in_duckdb`, `bench_small`.
- Measured (docs/BENCHMARKS.md): filters on 50M rows 0.06–0.79 s to first rows and count; sorts
  0.8–1.2 s to first and last rows (full sort 20–37 s in the background, D29); column profiles
  0.44–2.78 s; the small suite unchanged from v0.1.0 when both are run on the same machine today.
- Done criteria: a subset of a 50M-row file is found in seconds (filters, search, value lists,
  sorted ends); "Copy view as SQL" reproduces the view exactly — tests run the copied SQL in a
  fresh DuckDB and compare every value, order of ties included.
- Left over: the full 50M-row sort stays over 10 s on 4 cores (D29) and goes to the v1.0
  performance pass with the per-OS budgets.

## v0.3 — SQL and Export

### Step 1 — SQL panel ✅

- Bottom panel (Ctrl+J, palette "Show SQL panel"), resizable by its top edge, kept open/closed,
  height and text across restarts. CodeMirror 6: SQL highlighting with theme colours, line
  numbers, bracket matching, history, completion of keywords, table names and their columns.
- Every tab with full data is a table named from its file (`people.csv` → `people`, duplicates
  `_2`, …), registered as a view and dropped when the tab closes (D32).
- Run (Ctrl+Enter or the Run button) runs the selection, or everything; scripts are split into
  statements and run in order on the panel's own session connection (temp tables, `SET` and
  variables last), the last statement's rows shown in the grid (first 10,000 until step 3),
  with row count and time. Cancel while running. Format (sql-formatter, DuckDB dialect).
- Errors in plain words without DuckDB's `LINE` block; the position is underlined in the editor.
- Tested: Rust — tables by name (quoting, re-registering, joins, Parquet in place with a quote in
  the path), the session keeping temp tables/variables but not leaking them, a newer query
  cancelling the running one; Vitest — statement splitting, error positions (also shortened long
  lines), table names, the store's run/cancel rules, table sync; Playwright — autocomplete and
  Ctrl+Enter, format, error marking across statements, running a selection from the palette.
- Smoke (real app, people.csv): `SELECT city, count(*) AS n, round(avg(amount), 2) … GROUP BY 1`
  → 7 rows in 17 ms; `SELECT nope FROM people` → the binder error with "nope" underlined;
  `CREATE TEMP TABLE hi AS … WHERE amount > 900; SELECT count(*), min(amount) FROM hi` → 104,
  900.05 ("2 statements").
- Fixed on the way (CI-style run caught it): a request that runs several statements under one id
  (`open_view`) could, with its later statements, cancel a newer request of the same group. The
  registry now remembers each group's newest request and the ones it replaced; a replaced
  request's later statements start out cancelled. Unit test reproduces the old behaviour.
- Left over: none.

### Fixes from testing on Windows (after step 1)

- Grid empty after switching back to a tab until a sort/filter: a page could arrive before the
  grid reported what is on screen, and was never drawn. Now the grid redraws once it knows.
- Changing the theme recoloured everything but the grid until a tab switch: the canvas read the
  CSS colours before the new theme was applied. It now waits for the applied theme (also for
  density). Playwright reads a grid pixel before and after switching to dark.
- Panel toggles at the top right: sidebar (Ctrl+B), SQL panel (Ctrl+J), column profile
  (Ctrl+Alt+B), kept across restarts; the profile panel offers a column list when empty (D34).
- Right-click a cell: copy, copy with headers, copy value / column name, copy as …, only rows
  with this value / exclude it, sort, column profile, reload file (keeps filters). The webview's
  default menu is off outside text fields (D34).
- Memory: after an import or a big view is written, DuckDB's cached pages are handed back
  (D33); 166 → 61 MiB after a 100 MB CSV (`perf_memory_after_import`). Memory use while an
  import runs is DuckDB working within its limit (50 % of RAM, `memoryLimitMb` to change).
- Tested: Playwright for the toggles, the cell menu (copy with headers, filter by value, reload
  keeping the filter), the context-menu suppression and the theme pixel check (fails on the old
  code); Rust for releasing memory (limit restored, skipped while busy); Vitest for value filters.

### Step 2 — Tables for every file ✅

- Each tab with full data is a table named from its file; a chosen name wins and file names
  move out of its way (`people`, `people_2`, …, compared ignoring case as SQL does).
- `current_view` is the active tab's rows on screen: its view dataset (filters, search, sort)
  or the whole file; re-pointed when the view or the active tab changes, dropped with no tab.
- The SQL panel lists the tables as chips above the editor: a click types the name at the
  cursor, the pencil renames a file's table (letters, digits, `_`; unique; not `current_view`;
  Reset goes back to the file's name). The old name is dropped, the new one registered.
- Tested: Rust — `current_view` over a filtered + sorted view before and after it is written out
  (same rows, sorted top row); Vitest — chosen names and collisions, name checks, `current_view`
  following the view and the active tab, renames re-registering; Playwright — rename with
  invalid names rejected, `current_view` re-pointed after a sort, chips typing names.
- Smoke (real app, people.csv): palette "sort by amount desc", then `SELECT name, amount FROM
  current_view LIMIT 3` → 998.5, 998.18, 996.77 (the grid's top rows), 15 ms.
- Left over: names are kept for the session (workspaces in v0.6 will save them).

### Step 3 — Results ✅

- `sql_result`: the panel's last statement, when it is a query, is written once on the session
  into the scratch database and becomes a pageable dataset (D35); the grid pages all its rows
  (no more 10,000 cap for queries) and the status shows the full row count.
- "Open in tab": the result becomes a tab ("Result 1", "SQL result") with everything a file tab
  has — filters, sort, search, column profiles, copy as …, copy view as SQL over the query — and
  is a SQL table (`result_1`) for further queries. The panel's next run keeps it.
- Error positions of wrapped queries point at the user's text (line moved back, caret kept).
- Tested: Rust — SQL over CSV (people), Excel (orders sheet), JSON (accounts) and Parquet
  (in place), a CSV × Parquet join (count and sum checked against the parsed file), results
  paging in the query's order (ties broken by id), closing dropping the rows, session temp tables
  visible to results, error lines; Vitest — query detection, store runs (dataset for the final
  query, earlier statements fetch one row, previous result closed unless owned); Playwright —
  open in tab, status, result as a table, next run keeping the tab's rows, sorting the result.
- Smoke (real app, people.csv): `SELECT city, count(*) AS n FROM people GROUP BY 1 ORDER BY n
  DESC` → 7 rows in 22 ms; "Open in tab" → "Result 1" tab with its own columns, header
  histograms and "7 rows · SQL result".
- Left over: none.

### Step 4 — History and saved queries ✅

- Every finished run of the SQL panel is remembered (newest first, the same SQL moved to the
  top instead of copied, at most 500): when, how long, how many rows or that it failed.
  "History" in the panel (or the palette "SQL history…") lists and searches them; a click puts
  the query back in the editor (undoable); Clear empties the list. Cancelled runs are not kept.
- "Saved" (palette "Saved queries…"): name the current query (or the selection) to keep it;
  the same name in any case replaces it; a click loads it; the bin deletes it.
- Both are JSON files in the app data directory (`sql-history.json`, `sql-saved.json`), written
  whole (temporary file + rename); a broken file is set aside as `.broken`, never overwritten.
- Tested: Rust — order, de-duplication, search, limit, the 500 cap, persistence across a new
  library over the same files, saved names (case, empty name or SQL rejected, delete), broken
  files kept aside; Vitest — time-ago and first-line helpers, the store recording successes and
  errors but not cancels; Playwright — history with outcomes, search, load; save, load from the
  palette, delete.
- Smoke (real app): ran `SELECT count(*) AS adults FROM people WHERE amount > 100`, quit, started
  again; the palette's "SQL history…" listed it ("just now · 1 row · 29 ms") from
  `sql-history.json` in the app data directory.
- Left over: none.

### Step 5 — Export everything ✅

- Export the current view (filters, search, sort, shown columns in display order under their
  display names) or a SQL result to CSV, CSV.gz, TSV, Parquet (zstd), JSON (one array), NDJSON
  and Excel (D36). Open it with Ctrl+E, the palette ("Export view…"), the Export button in the
  file toolbar, or Export in the SQL panel.
- Options: header row, delimiter, quote every value, date and timestamp formats (strftime), the
  whole view or only the grid's selection (rows and columns); the format and options are
  remembered. Excel past 1,048,575 rows warns and offers more sheets or the first sheet only.
- Progress ("Exporting x.parquet… 42%") and "Cancel export" in the status bar; the outcome as a
  notice ("Exported 1,000 rows to people-export.xlsx in 14 ms"). Files are written as
  `.partial` and renamed when complete; a cancel or an error leaves nothing behind.
- Excel cells are typed: numbers, booleans, dates and timestamps (with date formats); integers
  past 15 digits, dates Excel can't hold and NaN as text; text cut at 32,767 characters; rows
  streamed from DuckDB into constant-memory sheets.
- Tested: Rust — every format round-trips a filtered, sorted view with a hidden, a reordered and
  a renamed column (re-opened as the app opens files, compared row by row with rows computed
  from the parsed CSV); selected rows and CSV options (no header, `;`, quote all, `%d/%m/%Y`);
  selected rows equal the grid's pages on a 300,000-row view, sorted and unsorted; cancel of a
  30M-row CSV and Excel export stops in ~1 ms and leaves no file; missing folder in words;
  Excel sheet splitting, typed cells and edge values (read back with calamine). Vitest — range
  merging, suggested names, the dialog (options, selection, save dialog cancelled, Excel
  warning, failures and cancels in words). Playwright — sorted view without a hidden column to
  Parquet with progress; a selection to CSV from the toolbar, then cancelled.
- Smoke (real app, people.csv): sorted by amount ↓, hid `city`, Export → Excel → GTK save
  dialog → "Exported 1,000 rows to people-export.xlsx in 14 ms"; openpyxl read 1,000 rows plus a
  bold header in view order, five columns, real dates, NULL as empty. SQL panel
  `SELECT count(*) AS adults …` → Export → JSON → `[{"adults":797}]`.
- Left over: none.

### Step 6 — Copy view as SQL / Open view in SQL panel ✅

- "Copy view as SQL" (v0.2, D31) stays as it was: standalone SQL over the file that runs in
  plain DuckDB.
- New: "Open in SQL" in the file toolbar and "Open view in SQL panel" in the palette put the view
  (filters, search, sort, shown columns under their display names) in the SQL panel as formatted
  SQL over the tab's SQL table (`FROM "people"`), so running it reads the imported data, not the
  file again (D37). It replaces the editor's text as one undoable change and opens the panel if
  it was closed; it doesn't run by itself.
- Fixed on the way: the SQL editor is created before its handle is given out, so text can go in
  the moment the panel opens (it was silently dropped before).
- Tested: Rust — for five views (filters of every kind, search, sorts with ties, chosen columns)
  the SQL over the registered table, run as the panel runs it (`sql_result`, paged), gives
  exactly the view's rows; Vitest — loading text with the panel open and closed (once, when the
  editor mounts); Playwright — sort, Open in SQL with the panel closed, formatted query over
  `"comma"`, the spec sent, undo restoring the old text, the palette command; "view as sql" in
  the palette still finds Copy view as SQL first.
- Smoke (real app, people.csv): sorted by amount ↓ and searched "Paris" (167 of 1,000 rows);
  Open in SQL → formatted query; Ctrl+Enter → "167 rows in 22 ms", same rows in the same order
  as the grid; Ctrl+Z brought back the earlier query.
- Left over: none.

### v0.3.0 release ✅

- Version test list: all Rust unit + integration tests (incl. the export round trips for every
  format, selected rows against the grid's pages, cancel, and the view's SQL over its table),
  Vitest (196), Playwright flows (SQL panel, tables, results, history, export, open in SQL),
  Tauri debug build; on demand: `perf_export_50m`, `bench_small`.
- Measured (docs/BENCHMARKS.md): on 50M rows Parquet export 7.6 s, CSV 23.9 s, sorted Parquet
  12.7 s; Excel 1M rows 14.7 s with flat memory; SQL `GROUP BY` 0.19 s (8 groups) / 1.44 s
  (100K groups); a 50M-row result 11.5 s to write, then pages in 12 ms. The small suite is
  unchanged from v0.2.0 on the same machine.
- Done criteria: every format can be queried with SQL (tests over CSV, Excel, JSON, Parquet and
  a CSV × Parquet join); every view or result exports correctly in every format (round trips).
- Fixed while getting CI green: a shortcut pressed right after a click on the grid (Ctrl+F,
  Ctrl+G, Ctrl+E) lost its focus to the grid, which focuses itself on the next frame; the
  shortcuts now act after that frame (a test slows every frame to make the race certain). A
  copy test read the clipboard before the copy landed.
- Left over: CSV.gz export is bound by DuckDB's single-threaded gzip (~14 MB/s of CSV); a
  parallel gzip goes to the v1.0 performance pass.

## v0.4 — Charts

### Step 1 — Aggregation in DuckDB ✅

- `chart_data`: bar, horizontal bar and line group the view's rows by any column (dates by day,
  week, month or year) with up to four measures (count, sum, average, min, max, distinct count);
  categories keep the 50 largest groups and report how many there are; numbers and dates on the
  x axis keep their order; histograms bin numbers and dates (a chosen number of bars, one per
  value for small integer ranges); scatter plots take a repeatable sample of 5,000 points and
  report the total (D38). Only the small result goes to the UI.
- Charts use the view's filters and search, never its sort or shown columns.
- Tested: SQL snapshots (quoting, buckets, time zones, sampling); every chart type over
  people.csv checked against values computed from the parsed CSV, with filters; errors in words
  for impossible charts. On 50M cached rows every chart takes 0.09–1.7 s (budget 2 s).
- Left over: none.

### Step 2 — Chart panel ✅

- A Grid | Chart switch in each tab's toolbar (and "Show a chart of the view" in the palette):
  the chart takes the grid's place under the same filter bar; each tab keeps its chart.
- Chart type, column, date bucket, measures (each with its colour), histogram bars, the scatter
  plot's y axis; a note when the chart shows part of the data ("Top 50 of 1,234 groups", "5,000
  of 50,000,000 points (random sample)", "empty dates not drawn") and the time taken; a table
  view of the chart's values.
- ECharts imported per chart type; series colours are design tokens with their own dark steps,
  checked with the data-viz palette validator; thin bars with rounded ends, 2 px lines, one
  value axis, a legend from two series, tooltips on hover; redrawn when the theme changes.
- Tested: Vitest for the option builder (bars, horizontal bars, lines over time, histograms,
  scatter plots), defaults, keeping a chart valid when its type changes, notes, the table;
  Playwright for switching, types, columns, measures, the view's search, the table, keeping the
  chart per tab, and the canvas colours in light and dark.
- Smoke (real app, people.csv): Chart → count by month (37 groups, 4 ms); bars by city match the
  file (東京 173, München 170, …) with a tooltip; histogram of id; scatter id × amount with 980
  points. Found and fixed: the x axis name was clipped, and the note counted a group of rows
  without a date that a time axis can't draw.
- Left over: none.

### Step 3 — Export chart, copy its SQL ✅

- Export from the chart toolbar or the palette: PNG (twice the screen's resolution, on the
  theme's background) or SVG (drawn again with ECharts' SVG renderer), saved where the save
  dialog says (`.png`/`.svg` only, written whole).
- Copy chart as SQL: one readable query over the file's reader with the view's filters and
  search inlined; it runs as-is in plain DuckDB and gives the chart's numbers.
- Tested: SQL snapshots; the copied SQL run in a fresh DuckDB over the CSV gives the chart's
  groups and values for bars and lines, the same bars for histograms of numbers, integers and
  dates, and the sample size for scatter plots; image checks (PNG data, SVG document, only those
  extensions, whole files); Playwright for copying and for PNG and SVG export from the toolbar
  and the palette.
- Smoke (real app, people.csv, dark theme): bars by month → Export → PNG image → GTK save dialog
  with `people-chart.png` suggested → a 2032×1202 PNG on the dark background, rounded bars,
  readable labels; SVG image → a standalone 1016×601 SVG document; Copy chart as SQL → the
  formatted query over `read_csv('…/people.csv', …)` with `date_trunc('month', …)`.
- Left over: none.

### v0.4.0 release ✅

- Version test list: all Rust tests (chart SQL snapshots, every chart checked against the parsed
  CSV, copied chart SQL in plain DuckDB), Vitest (205), Playwright (50: charts, theme colours,
  export), Tauri debug build; on demand `perf_charts_50m`.
- Measured (docs/BENCHMARKS.md): every chart type on 50M rows in 0.09–1.68 s (budget < 2 s).
- Done criteria: charts are fast on huge files (aggregated in DuckDB, one small result) and
  always match the filtered view (the same view builder as the grid; tests with filters).
- Left over: none.

## v0.5 — Clean, Compare, Quality

### Step 1 — Cleaning steps (recipe) ✅

- Ten steps: rename, change type (counts the values that don't convert; dates with an optional
  strptime format), trim, change case (Title Case as spreadsheets' PROPER: "o'neil" → "O'Neil"),
  find and replace (text or pattern, match case), split column, fill empty cells, remove
  duplicate rows (all columns or one), remove rows matching a filter, calculated column (a DuckDB
  expression).
- One chain of CTEs over the file, applied as a new dataset written in the background like a
  view; the file and its cache never change (D39). The grid, filters, profiles, charts, export and
  the tab's SQL table read the cleaned rows; filters on columns a step removed or renamed go.
- A Clean panel (toolbar, palette, "Clean column…" in the column menu): steps listed with what
  happened (failed conversions, errors, steps not applied), turn on/off, move up/down, remove,
  remove all; undo/redo (buttons, Ctrl+Z / Ctrl+Shift+Z, palette).
- Fixed on the way: Ctrl+F then typing at once lost the first key (the search box was focused one
  frame late); it is focused at once now, and the slow-frame test types right after the shortcut.
- Tested: SQL snapshots for every step; integration tests over people.csv check each step against
  values computed from the parsed CSV (column steps, failure counts, split/title/regex, row steps
  in file order, disabled and failing steps, a bad fill value) and that the exported script run in
  plain DuckDB gives exactly the app's rows; Vitest for descriptions, view fitting, the store
  (cleaned base for views and SQL, renames dropping filters, undo/redo, waiting for the import,
  closing datasets) and the panel; Playwright for the whole flow and the column menu.
- Smoke (real app, people.csv): Clean column… on name → Title Case: 1,000 rows cleaned in 3 ms
  ("søren smith" → "Søren Smith"); change name to number → "989 values couldn't be converted";
  Ctrl+Z from the grid undoes it; remove rows where amount < 0 → 913 rows (913 counted
  independently from the CSV); search "o'neil" → 130 of 913 rows; SQL panel `FROM people` sees
  the cleaned table (913 rows, lowest amount 0.28). Found and fixed: Title Case lowered letters
  after an apostrophe ("O'neil"), and the Clean button didn't look pressed with its panel open.
- Left over: none (saving, loading and exporting recipes is step 2).

### Step 2 — Recipes: SQL script, save/load, apply to another file ✅

- From the Clean panel's toolbar or the palette: Copy SQL, Export SQL… (a `.sql` file), Save…
  (a `.json` recipe), Load… (onto the tab's file; one undo brings the old steps back).
- The script is the same query the app runs over the file's reader, with a header and each
  step's description as a comment above it; disabled steps are left out.
- A recipe file keeps the columns (and types) it was made for: loading it onto a file without
  some of them, or with other types, says so in the panel; the steps still apply (D40).
- Tested: recipe files load back exactly, other files are refused with a reason (not JSON, not a
  recipe, a newer version, damaged), only `.json`/`.sql` are written, files are written whole; a
  recipe saved on people.csv cleans another file with the same columns exactly as expected; the
  labelled script runs in plain DuckDB and gives the app's rows; Vitest for the helpers, the
  column check and the panel; Playwright for copy, export, save and loading onto another file.
- Smoke (real app): people.csv → Title Case on name ("O'Neil Müller" stays right) → Save… through
  the GTK dialog (`people-recipe.json` suggested) → the JSON with its 6 columns and the step;
  Export SQL… → the commented script, which run in plain DuckDB 1.5.6 (Python) gives the same
  1,000 rows; Ctrl+O people-q2.csv (500 rows, no `joined`) → Load recipe… → "Loaded 1 step from
  smoke-recipe.json", names in Title Case, and the panel says the file has no column “joined”.
- Left over: none.

### Step 3 — Compare two files ✅

- Compare (toolbar, palette) with any other open tab: before/after (swappable), key columns
  (one like `id` suggested), Compare → a new tab of the differing rows: `status`, keys,
  `changed`, each compared column with its new value and a `(before)` column where it changed.
- A bar with the counts (each filters the rows), the same rows, changes per column, and notes
  for repeated keys (matched in order of appearance), columns of different types (compared as
  text) and columns only one side has. Changed cells are amber, added rows green, removed rows
  red (tokens, light and dark). The diff exports, filters, sorts and charts like a file (D41).
- Tested: fixtures `fixtures/compare/orders_v1.csv` → `orders_v2.csv` with documented
  differences (duplicate keys, a number column that becomes text): exact counts, columns and
  every row; keys checked on both sides; people.csv against an edited copy (every 50th row
  removed, every 7th amount changed, two added) against the differences worked out in Rust; the
  standalone SQL over both readers gives the same rows in plain DuckDB; Vitest for key
  suggestions, notes, changed cells, the dialog and the bar; Playwright for the whole flow,
  including the cell fills read from the canvas.
- Smoke (real app): `bigview orders_v1.csv orders_v2.csv` → Compare from v1 (v2 and `id`
  preselected) → "7 → 8 rows: 2 added · 1 removed · 4 changed · 2 the same", "Changed: qty 1 ·
  price 1 · note 2", both notes, the cells filled as expected in dark theme, 38 ms; "2 added"
  shows those 2 rows; Export → CSV through the save dialog gives exactly the documented rows.
- Left over: none.

### Step 4 — Data quality warnings ✅

- A Quality panel (toolbar with the warning count, palette) checks the rows the tab reads:
  mostly empty columns (≥ 20%), stray spaces, text that is mostly numbers with exceptions, dates
  in several formats, numeric outliers (beyond 3 IQR) and exact duplicate rows.
- Each warning's "Show rows" puts the filters it was counted with on the view, so it shows
  exactly that many rows; duplicates open a query in the SQL panel listing each duplicated row
  with its copies; "Fix" adds the cleaning step that clears it (trim, change type, remove
  duplicates) and the check runs again on the cleaned rows (D42).
- Measured on 50M rows: 33 s at first (exact quartiles, six regexes per text column); with the
  outlier bounds from a repeatable 100,000-row sample and number/date tests only on columns that
  look like them, 6.2 s warm, every count still over all rows.
- Tested: `fixtures/quality/messy.csv` with documented problems (see its README): every warning,
  count and message; each warning's filters give exactly its count; the three fixes applied as
  a recipe leave only the warnings without a fix; a clean file has none; Vitest for the panel;
  Playwright for show rows, fix (and the new check on the cleaned rows) and duplicates in SQL.
- Smoke (real app, messy.csv): 6 warnings in 16 ms matching the README; "Show 3 rows" on date
  formats → ids 4, 9, 16; Fix trim → 5 warnings; Fix duplicates → 20 rows, 4 warnings left.
- Left over: none.

### v0.5.0 release ✅

- Version test list: all Rust tests (recipe SQL snapshots; every step, recipe files, scripts in
  plain DuckDB; compare fixtures with duplicate keys and type differences, an edited people.csv
  and the standalone SQL; quality fixture with every warning, its rows and its fix), Vitest,
  Playwright (recipes, compare with canvas fills, quality), Tauri debug build; on demand
  `perf_recipe_compare_50m` and `perf_quality_50m`; small suite (`pnpm bench`) within the guard.
- Measured (docs/BENCHMARKS.md): on 50M rows a 4-step recipe shows its first page in 0.15 s
  (written in full in 14.8 s), a quality check takes 6.5 s, and comparing with an edited 50M-row
  copy 14 s.
- Done criteria: a messy file can be cleaned (fixture `messy.csv`: the quality panel's fixes
  and the cleaning steps), the steps saved as SQL (Export SQL…, run in plain DuckDB in the
  smoke test), and two file versions compared (`orders_v1.csv` → `orders_v2.csv`).
- Left over: none.

## v0.6 — Power features

### Step 1 — Open a folder or pattern as one table ✅

- Open folder (Shift+Ctrl+O, the empty window, the macOS File menu), "Open files matching a
  pattern…" in the palette (`logs/*.csv.gz`, `data/**/*.parquet`), dropping a folder, or
  `bigview <folder>`: the files are read as one table, columns matched by name, with a
  `filename` column (relative to the folder; `source_file` if the files have a `filename`).
- The most common format wins; other formats and empty files are left out and counted in the
  header tooltip, which lists the files ("CSV · 3 files · mixed"). Plain and `.gz` files mix;
  every gzip file is checked for damage. Import, cache (a digest of every file's path, size and
  time), views, SQL and Copy as SQL work as for one file; a Parquet folder is queried in place
  (D43).
- Tested: unit tests for folders, patterns across folders, hidden/empty/other files, mixed
  compression and the errors; integration tests for a CSV folder (union of columns, relative
  names, mixed .gz, the reader SQL in plain DuckDB), the cache following added and changed
  files, patterns, NDJSON and Parquet folders, a `filename` column clash; Playwright for Open
  folder and a pattern from the palette, and the header's file list. The UI recordings gained
  the new `files` field.
- Smoke (real app): `bigview sales/` (2024-01.csv, 2024-02.csv.gz, 2024-03.csv with an extra
  `channel` column, and notes.json) → "CSV · 3 files · mixed · 15.7 KB", 900 rows imported in
  44 ms, columns `order_id, customer, amount, channel, filename`; sorted by filename the March
  rows have `channel`, the others are empty; searching `2024-02.csv.gz` → 300 of 900 rows.
- Left over: none.


### Step 2 — Open files from a URL (HTTP(S) and S3) ✅

- "Open URL…" in the palette (or `bigview <url>`) opens `https://`, `http://` and `s3://`
  CSV, TSV, JSON and Parquet files, gzipped or not, named after the file in the URL (no query)
  with "remote" in the header. Parquet is queried in place in byte ranges; CSV and JSON
  import into the session and are never cached (D44).
- DuckDB's httpfs extension is installed once into the app's cache folder and loaded only when
  the first URL opens; extensions still never autoload. HTTP errors are said in words (404,
  401/403 with a pointer to the S3 settings).
- "S3 settings…" (also in the Open URL box): key ID, secret, region, endpoint, URL style, HTTPS,
  kept as one OS keychain entry (`keyring`) and applied as a temporary DuckDB secret. The UI
  never receives the secret; saving with it empty keeps the stored one. With no keychain
  service the box says so in words.
- Tested: unit tests for URL names, the secret SQL and a keychain round trip (mock), CLI URLs;
  integration tests against a local HTTP server with HEAD and ranges (CSV preview and import
  with nothing cached, gzip, Parquet in place with a page from the middle, 404, a URL without
  an extension, Excel); Vitest for URL names; Playwright for Open URL (validation, tab title,
  header) and saving, reloading, keeping and removing S3 settings.
- Smoke (real app, `python -m http.server`): `bigview http://127.0.0.1:8765/people.csv.gz` →
  httpfs installed into `~/.cache/app.bigview.desktop/duckdb-extensions`, "CSV · GZIP · REMOTE",
  1,000 rows imported in 172 ms; `types.parquet` from the Open URL box → 3 rows queried in
  place, all 18 types; `missing.csv` → "The server has no file at this address (HTTP 404)."
- Left over: the container has no Secret Service, so storing S3 settings in a real keychain was
  checked only with the keyring mock and in Playwright; S3 itself was not tested against a live
  bucket.

### Step 3 — SQLite and DuckDB files ✅

- SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`) and DuckDB (`.duckdb`, `.ddb`) files open like
  any file (dialog, drop, `bigview shop.duckdb`), told apart by their header bytes, attached
  read-only once per session under a name from the file (`Shop Data.duckdb` → `shop_data`),
  so the SQL panel can join their tables with anything else.
- A "Table" picker in the header lists tables (DuckDB with row counts), views, and other
  schemas as `schema.table`; the first table opens. DuckDB tables are queried in place;
  SQLite tables are imported and cached per table. The sqlite extension installs on first use,
  as httpfs does (D44); a changed file is attached afresh; a file locked for writing, another
  DuckDB version, no tables, a database URL or folder are said in words (D45).
- Buttons no longer shrink or wrap in a crowded header; the file name truncates instead.
- Tested: unit tests for detection by header (`.db` either way, no extension), attached names,
  attach error wording; integration tests for a DuckDB file (tables, views, other schema, row
  counts, in place with a deep page, the SQL name, read-only, a missing table), a SQLite file
  (types, preview, import, cache per table, `sqlite_scan` Copy-as-SQL in plain DuckDB), a
  changed SQLite file read again, an empty database and a database URL; Playwright for the
  picker (labels, SQL name, picking a table in another schema). UI recordings gained
  `database`.
- Smoke (real app): `bigview "Shop Data.duckdb" chinook.sqlite` → "DUCKDB · 9.8 MB",
  customers (97 rows) queried in place; picking orders (2,000,000 rows) → in place, the last
  page at once; chinook → sqlite extension installed, artists imported in 12 ms; in the SQL
  panel `chinook.tracks JOIN chinook.artists` with `shop_data.orders` → 4 rows in 25 ms.
- Left over: none.

### Step 4 — Workspaces ✅

- "Save workspace" (Ctrl/Cmd+S) and "Save workspace as…" (Shift) write a `.bigview` file:
  every file tab with its import settings, filters, sort and search, column layout, SQL name,
  chart, recipe and open side panel; the SQL panel's text, height and state; the side panels.
  Comparison and SQL result tabs are left out and counted in the notice. Save writes the same
  file again.
- "Open workspace…" (palette), or a `.bigview` file from the dialog, drop, recent files or
  `bigview work.bigview`, replaces the open tabs; each file reopens (from the cache when
  unchanged) and its view and recipe apply once its data is there. Files inside the
  workspace's folder are also saved by their path from there, so a moved project finds them
  (D46).
- `plural` is shared from `lib/format` instead of three local copies.
- Tested: unit tests for saving (relative paths, URLs, the format), loading a moved folder,
  missing files, other formats, newer versions and a bad active tab; Vitest for what a tab
  saves and a save/open round trip through the stores (views and recipes reapplied, the SQL
  text back, replaced tabs released); Playwright for Ctrl+S with the save dialog and opening
  from the palette (tabs, active tab, search, SQL text).
- Smoke (real app): people.csv searched for "Paris" plus chinook.sqlite, the SQL panel open →
  Ctrl+S suggested `people.bigview`, saved as `proj/work.bigview` with `data/…` relative
  paths; the folder moved to `proj-moved`, then `bigview proj-moved/work.bigview` → both tabs
  from the new place, "167 of 1,000 rows · filtered", the SQL text and panel back.
- Left over: none.

### v0.6.0 release ✅

- Version test list: all Rust tests (folders and patterns, HTTP and S3 sources against a local
  server, SQLite and DuckDB attachment, workspaces), Vitest, Playwright (folders, URLs,
  databases, workspaces), Tauri debug build; on demand `perf_sources`; CI green on Windows,
  macOS and Linux plus Playwright.
- Measured (docs/BENCHMARKS.md): a folder of 200 small `.csv.gz` files opens in 0.28 s, a
  50M-row DuckDB file in 0.03 s, a 1M-row SQLite table imports in 2.2 s, a Parquet file over
  HTTP shows its first page in 0.11 s.
- Fixed along the way: file names from patterns on Windows, concurrent extension installs on
  Windows, a Ctrl+F focus race in Playwright, a sort cancel test that raced on macOS.
- Merged to `main` in PR #6; tag `v0.6.0` (local).
- Left over: none.

## v1.0 — Polish and release

### Step 1 — Performance pass ✅

- Every budget measured on Windows, macOS and Linux: a Budgets workflow (on demand) generates
  each 5 GB / 50M-row fixture on the runner, runs the tests that measure it and deletes it; the
  Bench workflow (small suite and 30 % guard) runs on all three OSes, with baselines now
  recorded for Windows and macOS. Per-OS tables in docs/BENCHMARKS.md.
- All budgets met on all three runners except column stats of a near-unique column (39.5M
  distinct timestamps: 3.1 s Linux, 3.3 s Windows). Its most common values are now found by
  DuckDB's `approx_top_k` and counted exactly above 1M distinct values (D49): 4.8 s → 1.6 s
  on linux-dev; the profile panel says when the list comes from an estimate.
- Sorting 50M rows: every page is readable within seconds (5.7 s by date and price, 12.2 s by
  text) through a row-order table written before the full sort (D29 update).
- Found on Windows: zlib-rs (under flate2) panics in debug builds after 4 GiB of gzip input
  (a 32-bit `total_in`, which zlib lets wrap); release builds were fine. zlib-rs is now built
  without overflow checks in debug too, and an integrity check that stops unexpectedly is
  logged as an error instead of being dropped silently.
- The Excel slowdown seen at v0.6.0 (+23–27 % on the CI runner) was runner variance: the code
  is unchanged since v0.1.0, and this run came in 30–39 % under the same baseline.
- Tested: integration test of the estimated values on 1.5M rows (sentinel, NULL and a 1 %
  value found with exact counts, also through a filter); Vitest for the estimate note.
- Smoke (real app, Linux): `sales_50m.parquet` opened in place; the profile of `order_ts` lists
  timestamps seen twice, then once, with "Nearly every value is different: … found by an
  estimate (counts are exact)", in 3.1 s straight from the 0.8 GB Parquet (not cached).
- Second Budgets run after the fixes: column stats under 3 s on all three OSes (2.56–2.91 s),
  no gzip panic on Windows; two Windows numbers over by under 10 % on the 4-vCPU runner
  (every page of a two-key sort readable after 10.5 s; distinct customers per country 2.29 s),
  documented in docs/BENCHMARKS.md.
- Left over: cold start, idle memory and frame rate can't be measured on the hosted Windows and
  macOS runners (no desktop session); installer sizes per OS come with the release workflow.

### Step 2 — Settings screen and menu bar ✅

- A menu bar (File, Edit, View, Data, Help) on every OS, made of the palette's commands: each
  item runs the same command, shows its shortcut, and is disabled while it can't be used.
  File: New workspace (Ctrl+N), Open file / folder / pattern / URL, Open recent (files of the
  same name told apart by folder; Clear recent files), Open / Save / Save as workspace, Export,
  Reload, Settings, Close tab, Exit. On Windows and Linux it's drawn at the start of the tab
  row (Alt or F10 focuses it); on macOS the native menu bar is built from the same list with
  the app, text editing and Window menus (D47, replacing D22).
- Settings (Ctrl+, / File › Settings… / ⌘, on macOS): theme, density, column histograms;
  memory limit and worker threads (applied at once), temporary folder; cache on/off and size
  (at once) and location (after a restart); quiet-import size; export defaults; how to make
  BigView the default app. Values are checked by the backend and explained in words (D48).
- File associations in the installers (CSV/TSV, JSON/NDJSON, Parquet, Excel, SQLite, DuckDB,
  `.bigview`); on macOS files opened from the Finder arrive as an event and open like the
  command line. Help › Keyboard shortcuts (from the commands themselves) and About.
- Tested: unit tests for settings validation, live memory/thread limits; Vitest for the menus
  (titles, disabled items, separators, recent files and duplicates, macOS differences and
  native shortcuts); Playwright for the menu bar (disabled Export, File › Open file, Open
  recent, View › Theme › Dark, Alt and arrows, Help › Keyboard shortcuts) and Settings (a
  refused value in words, saving and reopening, density applied, restart notice).
- Smoke (real app, Linux): the File menu and Open recent; Settings showed 16 GB → 8,045 MB
  automatic and 4 cores; a memory limit of 0 → "The memory limit must be at least 256 MB.";
  4096 and Compact → saved to settings.json, rows compact, and in the SQL panel
  `current_setting('memory_limit')` = 4.0 GiB without a restart.
- Left over: the macOS native menu and the Finder open event are compiled and checked by the
  macOS CI job but not tried on a Mac.

### Step 3 — Onboarding ✅

- Three getting-started tips on the start screen, one at a time (Back / Next / Got it):
  opening big files; sorting, filtering, search and the column profile; the command palette
  and SQL. Closing them is remembered; Help › Show getting-started tips opens them in a dialog
  at any time (D50).
- "No file at hand? Try a sample dataset" on the start screen and Help › Open the sample
  dataset: 50,000 made-up orders (dates, regions, products, prices, discounts, a few empty
  customers, returns), generated by DuckDB into the app's data folder the first time and then
  reused, opened like any CSV.
- The start screen scrolls from the top when it's taller than the window (it was centred with
  `justify-center`, which cut its top off once the tips and a long recent list were added).
- Tested: integration test of the sample (written once, identical bytes each time, kept if
  present, typed columns, row count, date range, regions, categories, empty customers,
  returns); Vitest for the tips (steps, Got it and close remembered, shown on demand) and the
  sample button; Playwright for first run → tips closed → still closed after a reload → Help
  menu dialog, and the sample opening in a tab.
- Smoke (real app, Linux): tips and sample link on the start screen; the sample written
  (3.2 MB) and opened: 50,000 rows imported in 423 ms; Help › Show getting-started tips over
  an open file.

### Step 4 — Auto-update ✅

- Tauri's updater plugin (2.14.0), wrapped in our own commands: `update_status`,
  `check_update` (version, date and notes from the manifest) and `install_update` (download
  with progress events, signature check, install, restart). Help › Check for updates shows
  the latest version, a newer one with its notes and "Install and restart", the download's
  progress, or what went wrong in words with Try again.
- At startup the app checks quietly at most once a day (Settings › Updates, on by default)
  and opens the dialog only when there is a newer version; it never installs by itself.
- Signed manifests (D51): the release build adds the public key and the manifest URL
  (`latest.json` of the latest GitHub release) through a config overlay written by
  `scripts/updater-config.mjs`, signs its update bundles with the private key from a secret,
  and requires the signature to name the announced version (no downgrade by a doctored
  manifest). Other builds have no updater and say so. docs/RELEASING.md says how to make and
  store the keys (the publisher's; nothing secret is in the repository).
- Tested: Vitest for the update store (not set up, latest, newer, failed check, daily startup
  check, silent when offline, install progress and failure); Playwright for the dialog in
  each state, the startup prompt, Later not asking again that day, install progress, and the
  setting turned off.
- Smoke (real app, Linux): a debug AppImage built with the overlay and a throwaway key (in the
  scratchpad only) — the bundler wrote a `.sig` naming version 0.6.0; a local manifest
  announcing 9.9.9 was found at startup with its notes; installing it downloaded the bundle
  and refused it: "The update was signed for version 0.6.0 but the update endpoint announced
  version 9.9.9…", with the app still running. The normal build says it can't update itself.
- Left over: a full install-and-restart needs two signed releases; it is tried with the release
  workflow (step 7).

### Step 5 — Accessibility ✅

- WCAG 2.2 AA, checked by tests (D52): a contrast test of every text colour token against
  every background (both themes, selected-row tints included) and of the focus ring; axe-core
  in Playwright on the start screen, an open file, the palette, the filter editor, the
  shortcuts list, the SQL panel and Settings, in light and dark; a keyboard-only walkthrough.
- Contrast fixes: subtle grey, null and SQL comments were 2.2–3.9:1, now ≥ 4.5:1 in both
  themes; the light theme's error/warning/success and two syntax colours darkened slightly;
  the focus ring is ≥ 3:1; the shortcut badge on the accent button is an outline.
- Keyboard fixes: the tab bar follows the ARIA tabs pattern (arrows, Home/End, Delete closes);
  the SQL editor no longer traps Tab (Escape then Tab, or Ctrl+M) and shows a focus ring; the
  grid shows a ring while focused; the menu bar and chart selects show focus; the tips' Next
  button keeps the focus as it becomes "Got it".
- Target sizes ≥ 24 px: tab close, table rename, sidebar column rows. The tab close buttons
  left the tablist (the mouse's; Delete or Ctrl+W from the keyboard).
- Tested: Vitest contrast test (30 cases); Playwright axe scans (2 themes × 7 screens) and the
  keyboard walkthrough; tab tests now close by Delete and by the mouse.
- Smoke (real app, Linux): Tab from the window lands on the File menu with a visible ring;
  sidebar rows and greys as intended in the dark theme.

### Step 6 — Docs ✅

- README: v1.0 status, real screenshots of the sample dataset (grid with a profile in the light
  theme, the SQL panel, a chart in the dark theme; 400 KB in `docs/screenshots/`), the new
  features (menus, settings, tips and sample, updates, accessibility), current shortcuts,
  performance per OS, "How it works", install steps per OS (Windows setup or MSI and
  SmartScreen, the universal macOS DMG and Gatekeeper, AppImage/.deb/.rpm), file
  associations, contributing and licenses.
- CONTRIBUTING: reporting bugs, setup, the full check, which tests go where (Rust unit and
  integration, insta, Vitest, Playwright with the mock and recordings, axe and keyboard checks,
  performance and the bench guard), conventions, pull requests, license of contributions.
- docs/ARCHITECTURE.md: the layout as it is now, and sections on views, the SQL panel,
  settings, menus, updates and accessibility. docs/RELEASING.md (step 4) for keys.
- CHANGELOG: the v1.0 changes so far under Unreleased; the 0.5.0 heading, damaged by the
  0.6.0 release commit, restored. PROGRESS: the v0.6 and v1.0 entries, which had been written
  to a second file (docs/PROGRESS.md), merged back here in order, with the missing v0.6.0
  release entry. License: MIT (LICENSE, package.json, Cargo.toml agree).
- Tested: `pnpm lint`; every link in README and CONTRIBUTING points at a file in the
  repository.
