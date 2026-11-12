# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.6.1] - 2026-11-12

### Fixed

- Sixteen features' commands were refused by the installed app ("not allowed. Command not
  found"), although they worked in the tests: the JSON structure graph, statistics of big
  selections, Convert files, MySQL and PostgreSQL connections, the memory reading in the
  status bar, session autosave and restore, the crash notice and Copy diagnostics, and
  noticing files changed on disk. They were missing from the app's list of permitted
  commands; a test now keeps that list complete.
- In a development build (`pnpm tauri dev`) the grid stayed empty after a file was
  imported.

## [1.6.0] - 2026-11-09

Reliability: your work survives restarts and crashes, files changed on disk are noticed,
and big writes check for room first.

### Added

- Session autosave: the open files with their import settings, filters, sort, search,
  column layout, recipe and chart, plus the SQL text and panels, come back at the next
  start, after a restart or a crash (Settings › Appearance can turn it off).
- After a crash, a notice says your work was kept, with Copy diagnostics. Crashes and
  unhandled UI errors are kept in a local crash log; Help › Copy diagnostics copies the
  versions, system, settings, cache, last crashes and the end of the log. Nothing is sent.
- An open file that changes on disk (or is deleted) is noticed within seconds: Reload reads
  it again keeping the filters, sort and columns, or keep the rows as read.
- Free-space checks before exports, conversions and sorts too big for memory: a write that
  clearly won't fit is refused at once, saying how much is needed and free, and how to fix
  it; a drive that fills up while writing is said as such.
- Undo and redo for filters, sort, search and column changes (Ctrl+Z, Shift+Ctrl+Z or
  Ctrl+Y, and the Edit menu).

### Fixed

- A damaged cache entry (unreadable, or with missing rows) is rebuilt by importing the file
  again instead of failing; leftovers of interrupted imports and crashes are cleaned up at
  start (only files the cache wrote).
- A column layout with parts missing (from a hand-edited workspace) no longer breaks the
  grid.

## [1.5.0] - 2026-11-09

Speed on big files: faster opening, instant reopening, a grid that reads ahead, and a timer
and Stop for every long tool.

### Added

- A timer and Stop for Group by / pivot, Join, Append, Sample, Summarize every column, Count
  values and the JSON structure, in the status bar and in the tool's dialog.
- A plain warning while a query is using the disk because its data doesn't fit in memory,
  with how to speed it up; running out of memory (or of space in the temporary folder) says
  so in plain words, with the fix.
- CI time budgets for pivot, split export, convert, JSON structure and unnest.

### Changed

- Files imported before reopen at once, with their data, without reading the file (about
  7 ms instead of up to a second for a .csv.gz); a check of the file's first and last bytes
  runs in the background and imports again if it changed.
- Opening a file sniffs it once instead of once for its info, its first rows and its import
  (first rows of a 100 MB .csv.gz: 0.70 s → 0.50 s), and the import starts as soon as the
  file's info is known.
- The grid reads further ahead in the direction you scroll, and a fast drag no longer queues
  pages it has already left behind.
- Typing in the search box stops the search still running for the previous text; views over
  5 million rows wait a little longer for you to stop typing.
- Very wide files: the column list draws only the columns in view (tested with 2,000), and
  header histograms are computed for the columns on screen, the rest as you scroll to them.

## [1.4.0] - 2026-11-08

Flatten and filter nested JSON from the graph view.

### Added

- From the graph, pick a value or card: only records where a nested value equals it, only
  records that have a key, add a value (or all of an object's values) as columns, or unnest
  an array into one row per item. Columns and unnesting are cleaning steps (undoable, saved
  in recipes); filters on nested keys show as chips.
- An "Unnest into rows" cleaning step; records with an empty array are kept.
- Structure: "Count keys inside arrays" — how often each key appears among an array's
  items.
- The graph view for any file with nested columns (Parquet structs, lists and maps).

### Fixed

- Dates, timestamps, times, decimals and bytes inside objects show as dates and values in
  the graph, not raw numbers.
- A record that can't be read says so instead of loading forever.

## [1.3.0] - 2026-11-07

A graph view for JSON and NDJSON files.

### Added

- Graph (next to Grid and Chart, for JSON-like files): the selected record as connected
  cards — an object's plain values on its card, nested objects and arrays branching off — or
  the structure of every record, with each key's type, how often it is present and how long
  arrays are. Move between records, collapse and expand branches, search keys and values,
  pan and zoom, lay out left to right or top to bottom, see and copy any value's JSON path
  (and, in the structure, the SQL that reads it), copy the record as JSON, and save the
  graph as PNG or SVG. Big arrays are shown 50 items at a time; the structure is computed by
  DuckDB, so file size doesn't matter.

## [1.2.0] - 2026-11-03

Big-data tools without SQL, live MySQL and PostgreSQL databases, an MCP server for AI
assistants, conditional formatting, more charts and reports from the command line.

### Added

- Data tools (Data menu, palette, column menu), each opening its result as a new tab:
  Group by / pivot with count, distinct, sum, average, min, max, median, 95th percentile and
  standard deviation; Count values; Open a sample (random rows, a random share or the first
  rows); Append tabs (columns matched by name); Join with another tab (matching, all left,
  all, left with or without a match); Summarize every column.
- Export to a folder of files: one per value of a column (Hive layout), or files of N rows or
  about N MB.
- File › Convert files…: a folder of CSV, CSV.gz, TSV, JSON, NDJSON or Parquet files to
  another format, with progress and Cancel.
- File › Connect to a database…: MySQL / MariaDB and PostgreSQL, read-only, queried in the
  SQL panel (`SELECT * FROM cdr.calls`) or opened as tabs; saved connections keep the
  password in the system keychain.
- SQL panel: Explain (the query plan, or with timings) and a running timer.
- The status bar shows DuckDB's memory against its limit, and what spilled to disk.
- Format cells… (column menu): highlight rules and colour scales, saved with the layout.
- Charts: pie and ring, box plots, bars and lines split by a second column, stacked bars.
- Saved filter presets, reusable on any file with the same columns.
- Cleaning steps: round dates (hour to year) and shift times (e.g. +5:30).
- Copy selection as › Excel keeps leading zeros and long numbers; a button copies the
  selection's statistics.
- `dataliq run [recipe] --in FILE --out FILE`: a recipe applied and the result written, with
  no window, for scheduled reports.
- `dataliq mcp`: an MCP server so AI assistants (Claude Desktop, Claude Code, …) can list,
  describe and query files in folders you share, read-only and sandboxed; Settings › AI
  assistants turns it on and shows the configuration to copy.

### Fixed

- "Open a sample…" and Help › Open the sample dataset no longer share a command.
- Conditional fills keep cell text at WCAG AA contrast in both themes.

## [1.1.0] - 2026-11-03

Spreadsheet-style statistics of the selected cells in the status bar, and quicker column
handling in the sidebar: select or unselect all, find, invert and type icons.

### Added

- The status bar adds up the selected cells: count, sum, average, min and max (numerical
  count, distinct and blank cells on request). Small selections are added up at once; whole
  columns and millions of rows by DuckDB, cancelled when the selection changes. Click a value
  to copy it; right-click (or the sliders button) to choose which ones show.
- Summarize selection by column… in the cell menu: values, blanks, distinct, sum, average,
  min and max of each selected column, ready to copy.
- Sidebar columns: a "Show all columns" box selects or unselects every column at once (the
  pinned or first column stays shown), Find columns for wide files (the box and Invert then
  act on the matches), Invert, "Filtered" to show only the filtered columns, and a type icon
  per column.
- The sidebar's Files list switches tabs.

### Changed

- macOS installers: one disk image for Apple silicon and one for Intel Macs, built in
  parallel, instead of a single universal one; each gets its own update bundle.

## [1.0.0] - 2026-10-28

DataLiq 1.0: a new name and icon, a menu bar and settings, first-run tips and a sample
dataset, updates from signed releases, accessibility to WCAG 2.2 AA, every performance budget
measured on Windows, macOS and Linux, and installers built for all three by a release
workflow.

### Added

- A menu bar with every action (File, Edit, View, Data, Help) on every OS, recent files and
  workspaces included: in the window on Windows and Linux (Alt or F10), native on macOS.
- Settings (Ctrl+,): theme, density, memory limit and threads (applied at once), the cache's
  size and folder, the temporary folder, export defaults, update checks. The installers
  register DataLiq for its file types.
- Getting-started tips on the start screen and in Help, and a sample dataset to try
  everything on (Help › Open the sample dataset).
- Updates from signed GitHub releases: Help › Check for updates, and a quiet daily check at
  startup that asks before installing anything.
- Every budget measured on Windows, macOS and Linux (docs/BENCHMARKS.md).
- Installers for Windows (setup and MSI), macOS (one universal disk image) and Linux
  (AppImage, .deb, .rpm), built by a release workflow into draft GitHub releases with SHA-256
  checksums.

### Changed

- The app is now called **DataLiq**, with a new icon: a database stack with a forward
  chevron. Workspaces are `.dataliq` files, and settings, cache and logs live in the
  `app.dataliq.desktop` folders (settings from earlier builds start fresh).
- A column profile of a column where nearly every value differs is 3× faster: its most common
  values are found by an estimate and counted exactly, and the panel says so.
- The window is ready faster (under 0.95 s on Linux): the grid, SQL editor and charts load the
  first time they are shown.
- Colours meet WCAG 2.2 AA contrast in both themes; focus is visible everywhere; the tab bar
  works with arrows, Home/End and Delete; the SQL editor lets go of the keyboard with Escape
  then Tab; small buttons are at least 24 px.

### Fixed

- Every page of a 50M-row sort is readable within seconds instead of after the full sort.
- The start screen no longer cuts off its top when it is taller than the window.

## [0.6.0] - 2026-10-28

Power features: many files as one table, files from the web and S3, SQLite and DuckDB
databases, and workspaces that bring a whole session back.

### Added

- Open a folder (Shift+Ctrl+O, the empty window, a drop, `dataliq <folder>`) or a pattern such
  as `logs/*.csv.gz` or `data/**/*.parquet` as one table: columns matched by name, a
  `filename` column saying where each row came from, plain and gzipped files mixed, other
  formats left out and listed. Folders whose files share a header open as fast as one file.
- Open URL…: `https://` and `s3://` CSV, TSV, JSON and Parquet files (Parquet read in place, a
  page at a time). DuckDB's httpfs extension downloads on first use, so the app stays offline
  until then. S3 settings (key, secret, region, endpoint, URL style) live in the system
  keychain. Files from a URL are not cached.
- SQLite and DuckDB database files open read-only with a Table picker (views and other
  schemas included); DuckDB tables are queried in place, SQLite tables imported. Each file is
  also a database in the SQL panel (`SELECT * FROM shop.orders`), so files can be joined.
- Workspaces: Save workspace (Ctrl+S) keeps every tab's file, import settings, filters, sort,
  search, column layout, chart and recipe, plus the SQL panel; Open workspace (or opening a
  `.dataliq` file) brings them back, finding the files again when the project folder moved.

### Changed

- Toolbar buttons keep their labels on one line in a crowded header; the file name shortens
  instead.

## [0.5.0] - 2026-10-28

Clean, compare, quality: fix a messy file without touching it, compare two versions, and see
what is wrong with a file at a glance.

### Added

- Cleaning steps (Clean, or "Clean column…" in a column's menu): rename, change type (with a
  count of values that don't convert), trim, change case, find and replace (text or pattern),
  split a column, fill empty cells, remove duplicate rows, remove rows matching a filter, and
  calculated columns from a SQL expression. Steps can be turned off, reordered and removed, with
  undo and redo; the file itself never changes. Grid, filters, charts, exports and the SQL table
  all see the cleaned rows.
- Recipes: save the steps as a JSON file and load them onto any other file (missing columns are
  pointed out), or copy and export them as a readable SQL script that runs in plain DuckDB.
- Compare two open files by key columns: counts of added, removed, changed and unchanged rows
  (each one filters the list), the differing rows with changed cells highlighted and their old
  values beside them, notes on repeated keys and columns of different types; the differences
  export like any view.
- Data quality warnings (Quality): mostly empty columns, stray spaces, mixed numbers and text,
  dates in several formats, outliers and duplicate rows. Each shows exactly the rows it is
  about, and most have a one-click fix that adds the right cleaning step.

### Fixed

- Pressing Ctrl+F and typing straight away no longer loses the first key.

## [0.4.0] - 2026-10-27

Charts: chart any view of a huge file in about a second.

### Added

- A Grid | Chart switch on every tab: bar, horizontal bar, line, histogram and scatter charts of
  the current view, following its filters and search. Group by any column (dates by day, week,
  month or year) with up to four measures: count, sum, average, min, max, distinct count.
- All aggregation runs in DuckDB and only the small result is drawn: on 50M rows every chart
  takes 0.1–1.7 s. Categories show the largest 50 groups and say how many there are; scatter
  plots sample 5,000 points and say so.
- A table view of every chart's values; tooltips on hover; colours that follow the light and dark
  themes.
- Export a chart as PNG or SVG; copy a chart as SQL that runs in plain DuckDB over the file.

## [0.3.0] - 2026-10-27

SQL and export: query every open file with SQL, export any view or result.

### Added

- SQL panel (Ctrl+J): CodeMirror editor with highlighting, completion of keywords, tables and
  columns, run all or the selection (Ctrl+Enter), Format, Cancel, errors in plain words with
  the position underlined. Scripts run statement by statement on the panel's own session
  (temp tables, `SET` and variables last).
- Every open file is a table named after it (`sales_2024.csv` → `sales_2024`), renameable from
  the table chips; `current_view` is the active tab's filtered and sorted rows.
- Query results are datasets in the same grid: every row pages, not just the first ones; "Open
  in tab" gives a result filters, sort, search, profiles, copy and export, and it becomes a
  table (`result_1`) for further queries.
- Query history (searchable, with row counts, times and failures) and named saved queries,
  kept across restarts.
- Export (Ctrl+E, the toolbar, or the SQL panel) of the current view or a SQL result to CSV,
  CSV.gz, TSV, Parquet (zstd), JSON, NDJSON and Excel: the shown columns in order under their
  display names, filters, search and sort applied. Options: header row, delimiter, quoting,
  date and timestamp formats, the whole view or only the selection. Excel cells are typed;
  past 1,048,575 rows the export splits into more sheets or keeps the first. Progress and
  Cancel in the status bar; a cancelled or failed export never leaves half a file.
- Open view in SQL panel: the view as an editable query over the file's table.
- Panel toggles at the top right: sidebar (Ctrl+B), SQL panel (Ctrl+J), column profile
  (Ctrl+Alt+B).
- Right-click menu on cells: copy (with or without headers), copy the value or the column name,
  copy as …, keep or exclude rows with the value, sort, column profile, reload the file
  (filters kept). The webview's own menu is gone outside text fields.

### Changed

- DuckDB's cached pages are handed back after an import or a big view (166 → 61 MiB after a
  100 MB CSV).

### Fixed

- The grid could stay empty after switching back to a tab until the next sort or filter.
- Changing the theme left the grid in the old colours until a tab switch.
- A request running several statements could cancel a newer request of the same kind.
- A shortcut pressed right after clicking a cell (Ctrl+F, Ctrl+G, Ctrl+E) could lose its focus to
  the grid, closing Go to row or leaving the search box unfocused.

## [0.2.0] - 2026-10-27

Explore: narrow a 50M-row file down in seconds.

### Added

- Column filters by type: text (contains, equals, starts/ends with, regex, empty, each with "not"
  and a case option), numbers (equals, ranges, greater/less), dates (ranges, before/after, last N
  days), booleans, null / not null, and a searchable value list with counts. Filters show as
  chips; the status bar shows "N of M rows" and the time taken.
- Multi-column sort from the header (click, Shift+click), the column menu or the chips. On 50M
  rows the first and last 10,000 sorted rows are on screen in about a second while the rest
  sorts in the background ("Stop sorting" keeps the filters).
- Search across all text columns (Ctrl+F) with matches highlighted in the cells; Enter /
  Shift+Enter jump between matching rows.
- Column management: hide/show (header menu or the sidebar list), drag to reorder, pin to the
  left, rename the display name, auto-fit width; kept per tab.
- Column profiles in a side panel: rows, nulls, distinct values, min, max, mean, std dev, a
  histogram and the 10 most common values over the current filters (0.4–2.8 s per column on 50M
  rows); small histograms under the column titles (toggle in the status bar).
- Command palette (Ctrl+K) with every action and its shortcut.
- Copy a selection as CSV, TSV, JSON, Markdown or SQL INSERT (Shift+Ctrl+C).
- Copy view as SQL: a query over the file itself that reproduces the view (columns, names,
  filters, search, sort and order of ties) in plain DuckDB.
- Cancel a running filter or sort from the status bar.

### Changed

- A quoted empty CSV field (`""`) is read as an empty string, not NULL; cached imports are
  refreshed once.

### Fixed

- Pressing Enter on a filter with no value (e.g. "is empty") applies it.
- Clicking a header to sort no longer selects the whole column.

## [0.1.0] - 2026-10-26

First version: a fast viewer for huge tabular files.

### Added

- Project scaffold: Tauri v2 + React + TypeScript + Vite + Tailwind CSS.
- Design system: light/dark themes (follow OS by default), design tokens, bundled Inter and JetBrains Mono.
- App shell: tabs, sidebar, status bar, empty-state drop zone with recent files.
- DuckDB engine: memory limit and spill directory from `settings.json`, cancellable queries, results as Arrow IPC bytes decoded in the frontend.
- Test fixtures: small committed set and a deterministic generator for large files (`pnpm fixtures`).
- Open CSV/TSV files (also `.gz` and `.zst`) with instant preview: format detection by extension and content, DuckDB sniffing, Import settings (delimiter, header, quote, encoding, skip rows, date format, ignore bad rows), plain error messages.
- Data grid: canvas grid with virtual scrolling and paged loading (tested to 50M rows), type icons, type-aware cells, NULL vs empty string, column resize, range selection, copy as TSV, go to row (Ctrl+G).
- Background import into a disk cache with progress (incl. `.gz`), cancel, gzip integrity check, instant reopen of unchanged files, re-import on change, LRU size limit (default 20 GB), "Clear cache", free-space check with a "Read directly" fallback.
- JSON (array or NDJSON, also `.gz`/`.zst`) with nested values shown as JSON that expands pretty-printed; Parquet queried in place with an instant row count and fast paging; DECIMAL and TIME values formatted correctly.
- Excel `.xlsx` and `.xls`: sheet picker, header row detection and choice, typed columns (dates, numbers, booleans), cached formula values, fast streaming preview, background import.
- Tabs (close button, middle-click, Ctrl+W, Ctrl+Tab / Ctrl+Shift+Tab), open several files at once, recent files, drag and drop, `dataliq <files>` from a terminal, single instance (a second launch opens its files in the running app), macOS File menu.
- Check scripts (`scripts/check.sh`, `scripts/check.ps1`) and CI on Windows, macOS and Linux.
- Benchmarks: a small suite on 100 MB files with a regression guard (`pnpm bench`, `bench.yml`), on-demand large-file budgets, and a grid scroll check (`pnpm e2e:perf`).

### Fixed

- Cancelling an import just as it started (or finished) could be ignored and keep the imported data.
- Imports no longer finish up to 250 ms late waiting for the progress reporter.

[Unreleased]: https://github.com/mukesh-dsnl/dataliq/compare/v1.6.1...HEAD
[1.6.1]: https://github.com/mukesh-dsnl/dataliq/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/mukesh-dsnl/dataliq/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/mukesh-dsnl/dataliq/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/mukesh-dsnl/dataliq/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/mukesh-dsnl/dataliq/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/mukesh-dsnl/dataliq/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mukesh-dsnl/dataliq/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mukesh-dsnl/dataliq/releases/tag/v0.1.0
