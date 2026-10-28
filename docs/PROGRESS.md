
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
