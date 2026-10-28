
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
