# Architecture

DataLiq never loads a whole file into memory and never sends more rows to the
UI than are visible. DuckDB reads from disk; the UI only receives small Apache
Arrow pages and small aggregates.

## Layout

```
src-tauri/              Rust backend (Tauri v2)
  src/lib.rs            app setup, plugins, command list
  src/commands/         thin Tauri command handlers (one file per area)
  src/engine/           DuckDB session, connections, cancellation, extensions
  src/sources/          format detection, readers, folders, databases, URLs
  src/import/           background import, progress, gzip integrity check
  src/cache/            cached imports (DuckDB files), size limit
  src/view/             ViewSpec -> SQL, paging, sorted views, column profiles
  src/sql/              the SQL panel: tables, results, history, saved queries
  src/export/           exports to CSV, Parquet, JSON, Excel
  src/chart/            chart aggregation SQL
  src/recipe/           cleaning steps -> SQL, recipe files and scripts
  src/compare/          comparing two files by key
  src/quality/          data quality warnings and fixes
  src/remote/           HTTP and S3 sources, keychain credentials
  src/workspace/        .dataliq workspace files
  src/settings.rs       settings.json (memory, threads, cache, folders)
  src/menu.rs           the native macOS menu bar
  src/sample.rs         the sample dataset
  src/cli.rs            files given on the command line
  tests/it/             integration tests (and #[ignore]d performance tests)
  benches/              criterion benchmarks
src/                    React frontend
  app/                  app shell, commands, shortcuts
  components/           grid, filters, profile, sql, chart, recipe, compare,
                        quality, export, import, palette, settings, shell, ui
  stores/               Zustand stores (tabs, views, SQL, layout, settings, …)
  lib/                  IPC, Arrow decoding, menus, formats, platform helpers
  styles/               design tokens (contrast-tested) and global CSS
e2e/                    Playwright flows (mocked backend), axe and keyboard checks
scripts/                check, smoke, benchmarks, fixtures, updater config
fixtures/               small committed fixtures (< 1 MB each)
bench/                  benchmark baselines per OS
docs/                   architecture, decisions, benchmarks, releasing
```

## Engine

`engine::Engine` owns one in-memory DuckDB database. Every query runs on its
own connection (`try_clone`) inside `spawn_blocking`, so the UI thread never
waits on DuckDB. The memory limit (default 50% of RAM) and spill directory
come from `settings.json` in the OS config directory.

Requests carry an optional id and group. `cancel_query(id)` interrupts a
running query; starting a request in a group (e.g. one grid view) interrupts
older requests in the same group, so a newer scroll or filter always wins.

Results travel as raw Arrow IPC stream bytes (`tauri::ipc::Response`), decoded
in the frontend with `apache-arrow` (`src/lib/arrow.ts`). No JSON for rows.

## Opening a file

`sources::Source` detects the format (`sources/detect.rs`: extension, double
extensions like `.csv.gz`, and magic bytes), validates user import settings,
and builds the DuckDB reader call (`read_csv(?, delim = ?, …)`) with every value
bound. `open_file` returns detected settings (`sniff_csv`), columns and the
reader SQL; `preview_file` returns the first 1,000 rows as Arrow. The UI runs
both in parallel. Reader errors are rewritten into plain messages with a fix
(`sources/friendly.rs`).

## Import and cache

After the preview is on screen, the UI starts `import_file` in the background
(`import/mod.rs`). The file is copied into a DuckDB database
(`CREATE TABLE data AS SELECT * FROM read_csv(…)`) written to
`<cache>/<key>.duckdb.partial` and renamed only on success; the key hashes the
absolute path, size, modified time and import options (`cache/mod.rs`). A
finished database is attached read-only and registered as a dataset that the
grid pages by rowid. Reopening an unchanged file just attaches the cached
database. Gzip input is verified in parallel (`sources/integrity.rs`). The
cache is cleaned least-recently-used to its size limit; open datasets are never
removed.

## Data flow

```
UI (grid, filters, SQL)  --ViewSpec / SQL-->  Tauri command
   ^                                              |
   | Arrow IPC bytes (one page or one aggregate)  v
   +------------------------------------  Rust: view builder -> DuckDB
```

## Views

A tab's view (filters, search, sort, hidden and renamed columns, cleaning
steps) is a `ViewSpec`, turned into one SQL query over the dataset by
`view/sql.rs` (insta snapshots pin the SQL). `open_view` returns the row count
and the first page at once; a filtered or sorted view over many rows is then
written in full to a temporary table in the background, and pages read from it
once it lands. Until then, sorted pages come from the first and last rows, then
from a row-order table written first (D29); "Copy view as SQL" gives the same
query as plain DuckDB SQL. Column profiles, header histograms, charts, quality
warnings and comparisons are aggregate queries over the same view, so only
small results cross to the UI.

## SQL panel

Every open file is registered as a table (named after the file) on a session
connection, plus `current_view` for the active tab. Results are datasets like
any file: paged, opened as tabs and queryable themselves. History and saved
queries live in the app's data folder.

## Around the data

Settings (`settings.rs`) are applied to the running engine where DuckDB allows
it (memory, threads); folders apply after a restart (D48). The menu bar and
the palette share one list of commands (D47). Updates come from signed GitHub
releases through Tauri's updater, turned on only in release builds (D51).
Accessibility rules are enforced by tests (D52).
