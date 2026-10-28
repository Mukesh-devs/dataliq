# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-10-28

Power features: many files as one table, files from the web and S3, SQLite and DuckDB
databases, and workspaces that bring a whole session back.

### Added

- Open a folder (Shift+Ctrl+O, the empty window, a drop, `bigview <folder>`) or a pattern such
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
  `.bigview` file) brings them back, finding the files again when the project folder moved.

### Changed

- Toolbar buttons keep their labels on one line in a crowded header; the file name shortens
  instead.

 - 2026-10-28

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
- Tabs (close button, middle-click, Ctrl+W, Ctrl+Tab / Ctrl+Shift+Tab), open several files at once, recent files, drag and drop, `bigview <files>` from a terminal, single instance (a second launch opens its files in the running app), macOS File menu.
- Check scripts (`scripts/check.sh`, `scripts/check.ps1`) and CI on Windows, macOS and Linux.
- Benchmarks: a small suite on 100 MB files with a regression guard (`pnpm bench`, `bench.yml`), on-demand large-file budgets, and a grid scroll check (`pnpm e2e:perf`).

### Fixed

- Cancelling an import just as it started (or finished) could be ignored and keep the imported data.
- Imports no longer finish up to 250 ms late waiting for the progress reporter.

[Unreleased]: https://github.com/mukesh-dsnl/dataliq/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mukesh-dsnl/dataliq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mukesh-dsnl/dataliq/releases/tag/v0.1.0
