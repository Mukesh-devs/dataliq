# BigView

> Drag in a 5 GB file. See data in 1 second. Filter, query, and export without loading it into RAM.

BigView is a free, open-source, cross-platform desktop app for exploring huge
tabular files: CSV, TSV, Parquet, JSON/NDJSON and Excel, including `.gz`
compressed files of 5 GB and more. It is built with [Tauri v2](https://tauri.app),
Rust and [DuckDB](https://duckdb.org). It works fully offline, with no telemetry
and no account.

**Status:** v0.5.0 — SQL over every open file, export to every format, charts, cleaning
recipes, file comparison and data quality checks. Folders, URLs and database files come in
v0.6. See [CHANGELOG.md](CHANGELOG.md),
[PROGRESS.md](PROGRESS.md) and the roadmap in [BUILD_PLAN.md](BUILD_PLAN.md).

<!-- Screenshots: light and dark theme with a 50M-row file open. -->
_Screenshots coming soon._

## Features

- Open CSV, TSV, JSON and NDJSON files, also compressed (`.gz`, `.zst`), with
  the first 1,000 rows on screen in about a second, even for 5 GB `.gz` files.
  Nested JSON values expand into pretty-printed JSON.
- Parquet is queried in place: a 50M-row file opens in under 0.1 s.
- Excel `.xlsx` and `.xls` with a sheet picker and header row choice.
- Delimiter, header, quoting and types are detected automatically; override
  them in **Import settings** (delimiter, header, quote, encoding, skip rows,
  date format, ignore bad rows).
- The full file is imported in the background into a local cache (with
  progress and Cancel) while you browse the preview; reopening an unchanged
  file is instant.
- A fast canvas data grid: type icons, right-aligned numbers, `null` shown
  distinctly from empty text, column resize, range selection and copy, and
  **Go to row** (Ctrl+G).
- Filter any column by type (text: contains, equals, starts/ends with, regex,
  empty; numbers: equals, ranges, greater/less; dates: ranges, before/after,
  last N days; booleans; null / not null) or by picking values from a
  searchable list with counts. Filters show as chips; "N of M rows".
- Sort by one or several columns (click, Shift+click). On 50M rows the first
  and last rows appear in about a second while the rest sorts in the
  background.
- Search all text columns (Ctrl+F) with matches highlighted in the grid.
- Hide, reorder (drag), pin, rename and auto-fit columns.
- Column profiles: rows, nulls, distinct values, min, max, mean, standard
  deviation, a histogram and the most common values, following the current
  filters; small histograms in the column headers.
- Command palette (Ctrl+K) with every action; copy a selection as CSV, TSV,
  JSON, Markdown or SQL INSERT (Shift+Ctrl+C); **Copy view as SQL** gives a
  query that reproduces the current view in plain DuckDB; cancel running
  queries from the status bar.
- **SQL panel** (Ctrl+J): every open file is a table (`sales_2024`), plus
  `current_view` for the active tab's filtered rows. Completion of tables and
  columns, run all or the selection, format, errors pointed out in the editor;
  results page through every row, open in their own tab and become tables
  themselves. Searchable history and saved queries.
- **Export** (Ctrl+E) the current view or a SQL result, exactly as shown, to
  CSV, CSV.gz, TSV, Parquet, JSON, NDJSON or Excel (typed cells, more sheets
  past Excel's row limit), with header, delimiter, quoting and date options,
  the whole view or just the selection, progress and Cancel.
- **Open view in SQL panel** turns the current view into a query to edit.
- **Charts** of the current view: bar, horizontal bar, line, histogram and
  scatter, grouped by any column (dates by day, week, month or year) with
  count, sum, average, min, max or distinct count. DuckDB does the work, so a
  chart of 50M rows takes about a second. Export as PNG or SVG, or copy the
  chart as SQL.
- **Clean** without touching the file: rename, change type (failed conversions
  are counted), trim, change case, find and replace, split, fill empty cells,
  remove duplicates or rows matching a filter, and calculated columns; turn
  steps off, reorder them, undo and redo. Save a recipe and apply it to the
  next file, or export it as a SQL script that runs in plain DuckDB.
- **Compare** two open files by key columns: added, removed and changed rows
  with the changed cells highlighted and their old values beside them.
- **Data quality** warnings: mostly empty columns, stray spaces, mixed types,
  inconsistent date formats, outliers and duplicate rows, each one showing
  exactly the affected rows and, where it can, fixing them with one click.
- Light and dark themes that follow your OS.
- Tabs, recent files and drag and drop; open files from a terminal with
  `bigview data.csv.gz other.parquet` (a second launch opens them in the
  running app).

## Keyboard shortcuts

Use Cmd on macOS, Ctrl elsewhere.

| Action | Shortcut |
| --- | --- |
| Open file | Ctrl+O |
| Command palette | Ctrl+K |
| Find in data | Ctrl+F |
| Close tab | Ctrl+W |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Go to row | Ctrl+G |
| Copy selection (TSV) | Ctrl+C |
| Copy as CSV / JSON / Markdown / SQL | Shift+Ctrl+C |
| Sort by a column / add a sort key | Click / Shift+click a header |
| Export | Ctrl+E |
| Show / hide the SQL panel | Ctrl+J |
| Run SQL (or the selection) | Ctrl+Enter |
| Show / hide the sidebar | Ctrl+B |
| Show / hide the column profile | Ctrl+Alt+B |

## Performance

Measured on a 4-core Linux machine (details in [docs/BENCHMARKS.md](docs/BENCHMARKS.md)):
first rows of a 5 GB CSV in 0.3 s and of a 5 GB `.csv.gz` in about 1 s; full
import of a 5 GB CSV in 32 s; reopening a cached file in a few milliseconds;
random pages anywhere in 50M rows in under 25 ms. On 50M rows: a filter
shows its first rows and count in 0.1–0.8 s, a sort its first and last rows in
about 1 s, a column profile takes 0.4–2.8 s, a chart 0.1–1.7 s, an export
to Parquet 7.6 s, a cleaning recipe its first page in 0.15 s, a data quality
check 6.5 s, and comparing it with a 50M-row edited copy 14 s.

## Installing

Releases have no published installers yet; build from source (below). The
Linux build produces `.deb`, `.rpm` and `.AppImage` packages, which need
WebKitGTK 4.1 (`libwebkit2gtk-4.1-0`, preinstalled on most desktops).

## Building from source

Prerequisites:

- Rust (stable) and Node.js 22 with pnpm 10
- Linux: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- macOS: Xcode command line tools
- Windows: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11)

```sh
pnpm install
pnpm tauri dev          # run the app with hot reload
pnpm tauri build        # build installers into target/release/bundle
./scripts/check.sh      # run every check (fmt, clippy, tests, lint, build)
pnpm fixtures all       # generate the large test files (16+ GB, git-ignored)
pnpm bench              # small benchmark suite with the regression guard
```

## License

[MIT](LICENSE)
