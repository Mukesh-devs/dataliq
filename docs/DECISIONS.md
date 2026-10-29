# Design decisions

Design decisions and clarifications, with the reasoning.

## D1 — Repository root is the project root

The plan shows a `dataliq/` folder. This repository *is* the project, so
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

## D17 — Import progress through DuckDB's C API

The `duckdb` crate does not expose `duckdb_query_progress` or the raw
connection handle. The engine therefore opens the database itself through the
C API (`engine/raw.rs`, `duckdb_open_ext` with our settings) and wraps it with
`Connection::open_from_raw` for normal queries. Imports run on a raw
connection with `enable_progress_bar` on; a second thread polls
`duckdb_query_progress` (atomics inside DuckDB) every 250 ms and emits
`import-progress` events. For CSV, DuckDB's percentage is based on bytes read
— compressed bytes for `.gz` — which is what the plan asks for.

## D18 — Caching disabled and low disk space

With caching off, imports still write a DuckDB file (paging needs a table with
contiguous rowids) but into a per-process temp folder deleted on exit. When the
cache disk lacks room for the estimated database (0.5× the file size, or
1.5× for compressed input, plus 1 GB — measured databases are ~0.2× and
~0.4×), the import stops with a plain message and the UI
offers **Read directly**: the grid then pages `read_csv(...)` with
LIMIT/OFFSET — no disk needed, slower when jumping deep into the file.

## D19 — Parquet paging by `file_row_number`

Parquet is queried in place. Pages use
`read_parquet(?, file_row_number = true) WHERE file_row_number BETWEEN …`,
which DuckDB pushes down to row groups: ~23–28 ms per page anywhere in a
50M-row file, versus 36 → 86 ms for LIMIT/OFFSET as the offset grows. Files
that already have a `file_row_number` column fall back to LIMIT/OFFSET.

## D20 — Arrow IPC recordings are compared decoded

Arrow buffers under NULL slots carry whatever memory DuckDB left there, so
IPC bytes for the same result differ between runs. Tests that guard recorded
or committed IPC data compare decoded record batches, never raw bytes.

## D21 — Excel: calamine + Appender, rules for headers and blank rows

Excel files are read with calamine (no DuckDB extension needed, works
offline). For `.xlsx` the preview streams cells and stops after the first
rows (54 ms for a 1M-row sheet); the full import reads the sheet, infers one
type per column from all values (integral numbers → BIGINT, other numbers →
DOUBLE, dates → DATE/TIMESTAMP, mixed → VARCHAR) and appends rows with
DuckDB's Appender into the cached database. Formula cells use their cached
values. Fully empty rows are skipped. The header row is the first non-empty
all-text row, skipping title rows that have fewer cells than the rows below;
users can pick another row or "No header row". The legacy `.xls` fixture is
written by `scripts/make_xls.py` (xlwt), since no Rust crate writes BIFF8.

## D22 — Native menu on macOS only

_Replaced by D47 (v1.0): every OS has a menu bar now._

macOS apps are expected to have a menu bar (and it provides Copy/Paste in
text fields), so DataLiq installs the standard menu plus File > Open… /
Close Tab there. On Windows and Linux a menu bar would add a row of chrome
the layout doesn't have; the same actions are on the keyboard (Ctrl+O,
Ctrl+W, Ctrl+Tab), in the tab bar, and in the command palette (v0.2).

## D23 — One integration-test binary

Every Rust integration-test binary links DuckDB statically (~100 MB each).
All integration tests live in `src-tauri/tests/it/` as modules of one binary,
which cut `target/` growth and link time considerably.

## D24 — AppImage size is outside the installer budget

The 40 MB installer budget is met by the `.deb` and `.rpm` (19.4 MB), which
use the distribution's WebKitGTK. An AppImage must bundle WebKitGTK and
GStreamer to run everywhere, which makes it ~92 MB; there is no way to get
it near 40 MB without dropping the format. We keep it (it is the only
package for distributions without .deb/.rpm) and record its size separately.

## D25 — Idle memory is measured as PSS and reported with private memory

"Idle memory (whole app incl. webview)" is measured as the PSS of all app
processes, which counts shared library pages proportionally. On Linux under
Xvfb this is 241 MiB, over the 200 MB budget, but only 77 MiB of it is
private memory; the rest is WebKitGTK/JavaScriptCore code, the DuckDB code
in our binary, and llvmpipe (software GL, absent with a GPU). We report both
numbers and revisit on real desktops with GPUs on all three OSes in v1.0
rather than chase library pages now.

## D26 — Benchmark baselines come from the CI runner

The regression guard compares against `bench/baseline/<os>.json`, recorded
by the Bench workflow itself, because timings from a developer machine don't
transfer to a CI runner. Without a baseline the workflow only reports (and
uploads the results to commit as the baseline). The guard keeps the fastest
of 5 runs and ignores slowdowns under 5 ms, because shared runners are noisy.
It runs on version tags, on demand, and on pushes that change the benchmark
itself (to record a baseline), not on every push.

## D27 — View SQL: bound values, local "today", NULL-friendly negation

Views (`src-tauri/src/view/`) are built from a serializable `ViewSpec`.
Column names are looked up in the dataset's schema (unknown names are a plain
error) and quoted; every value, including regex patterns and search text, is
a bound parameter. Text tests (`contains`, `starts_with`, `ends_with`,
`regexp_matches`) run on a column's text form, so they work on any type;
comparisons use the column's own type, so dates are given as ISO text.

DuckDB's `current_date` lives in the ICU extension, which we don't bundle
(and extensions are never downloaded), so "last N days" binds both ends of
the range from the user's local date, computed in Rust. That is also what
the user means by "today", and it makes the SQL testable with a fixed date.

A negated filter is `NOT coalesce(test, FALSE)`, so "doesn't contain x"
keeps NULL cells instead of silently dropping them, as SQL's three-valued
logic would. Sorts are always `NULLS LAST`, in both directions.

## D28 — A quoted empty CSV field is an empty string

DuckDB's CSV reader treats `""` as NULL by default (`allow_quoted_nulls`).
That erases the difference between "no value" and "an empty string" that a
file states explicitly, and DataLiq shows NULL and empty text differently.
We read CSV/TSV with `allow_quoted_nulls = false`: an unquoted empty field is
NULL and `""` is an empty string. The cache format version was bumped so
files imported before the change are imported again.

## D29 — Sorted views: first and last rows first, full sort in the background

A sort has to read every row, and writing 50M sorted rows takes 20–40 s on
a 4-core machine — over the 10 s budget. What the user needs first is the
top of the sort (and often the bottom), which DuckDB answers with a single
scan using a top-N heap (about 1 s). So a sorted view writes its first
10,000 rows at once and opens; a background job then writes the last 10,000
(from the exact reverse order: every key flipped, NULLs first, tiebreak
descending) and finally the full sort into the session's scratch database,
and the dataset switches to that table. Pages in the head or tail are served
immediately; pages in the middle wait for the full table. A `view-ready`
event tells the UI when it is done ("first rows in …, sorting the rest…" →
"sorted in …").

Filter-only views are counted immediately (and read through their query)
and written out in the background too, so deep pages get fast without
delaying the count. Views live in a scratch database on disk (compressed,
not counted against the memory limit) that is deleted on exit; leftovers
from a crash are removed at the next start. Ties keep file order for
imported tables (rowid tiebreak).

Sorting only the row ids (15.6 s) and joining back for each page was
rejected as a replacement: pages took over a second each. Measured again
at v1.0 (DuckDB 1.5.6) it is a good bridge: over an imported table, the
background job writes the view's order by row id right after the tail
(one 8-byte value per row: 50M rows in about 4 s), and pages in the middle
are read through it (0.3 s each) until the full sort lands (then about
10 ms). Every page of a 50M-row sort by date and price is readable after
5.7 s instead of 24 s, by a text column after 12.2 s instead of 43 s;
the 10 s budget is met for number and date keys. Views over a query or a
Parquet file (no stable row ids) still wait for the full sort.

## D30 — Column profiles from one aggregate query per column, not SUMMARIZE

The plan suggests DuckDB's `SUMMARIZE`. It profiles every column of a
relation at once, computing approximate quantiles and `approx_unique` for
all of them, so profiling one column of a 9-column, 50M-row view pays for
all nine. Instead a profile runs three queries over the view (filters and
search, no sort): one aggregate (count, non-null count, min, max, mean,
sample std dev, distinct — exact up to 10M rows, HyperLogLog above, marked
"≈"), a fixed-width histogram, and the 10 most common values, grouped by the
typed value and cast to text only for the rows kept. Each column takes
0.4–2.8 s on 50M rows (budget < 3 s).

Header mini-histograms use the same histogram query for every number, date
and boolean column, after a single scan for all their ranges. They are
exact (not sampled) and load behind the grid; the headers grow from 32 to
46 px to fit them, and the status bar has a toggle to turn them off
(persisted).

## D31 — "Copy as SQL" reads the file itself; copy and cancel rules

"Copy view as SQL" must run as-is in plain DuckDB and give the rows on
screen, so it cannot name the app's cache table. It selects from the file's
own reader call (`read_csv(...)` with the detected dialect, `read_json`,
`read_parquet`) with every value inlined as a literal (`?` inside quoted
strings and identifiers left alone), the shown columns in display order
under their display names, and, when sorted, a `row_number() OVER ()`
tiebreak so equal keys keep file order as they do in the app (rowid). Tests
run the copied SQL in a fresh DuckDB connection and compare every value
with the app's view, ties included.

Excel sheets are read with DuckDB's `excel` extension (`read_xlsx`): the
rows below the header (`header = false`, an open-ended `range`), blank rows
dropped as the import does, each column aliased to the app's name, and
integer columns cast back from DOUBLE. An on-demand test downloads the
extension and checks it against the app's import cell by cell. DuckDB can't
read `.xls`, so for those the SQL names the sheet as a table to load first.

Copying a selection as CSV/TSV/JSON/Markdown/SQL INSERT reads the rows
through the grid's page cache in chunks of 5,000 and stops at 100,000 rows
(the status bar says so); bigger extracts belong to Export (v0.3).
Shift+Ctrl+C opens the command palette already filtered to "Copy ".

Cancel (status bar or palette) abandons a view still being computed: the
tab goes back to the rows on screen and the filters they were computed for.
For a sort finishing in the background (D29) it drops the sort and keeps
filters and search, since a half-written sort can't page its middle rows.

## D32 — SQL panel: tables from step 1, one session connection, capped results

The plan names tables for open files in step 2, but a SQL panel with nothing
to query can't be used or tested, so step 1 already registers every tab with
full data as a view in the in-memory main schema, named from its file
("Sales 2024.csv.gz" → `sales_2024`, then `sales_2024_2`, …); step 2 adds
renaming and `current_view`. A view over the dataset costs nothing and
follows re-imports (`CREATE OR REPLACE`).

The panel runs on one session connection of its own, so `CREATE TEMP TABLE`,
`SET` and variables carry over between statements as in any SQL client; the
grid and views keep their own connections. A newer panel query interrupts
the running one before taking the session. Scripts are split into
statements in the frontend (`;` outside strings, quoted names, `$$` and
comments), run in order, and the last statement's rows are shown; DuckDB's
`LINE n` + caret gives the error position, mapped back into the editor
(selections included). Until results become pageable datasets (step 3) the
panel shows the first 10,000 rows and says so.

The dialect for highlighting and completion is CodeMirror's PostgreSQL,
the closest it ships to DuckDB; formatting uses sql-formatter's DuckDB
dialect.

## D33 — Give DuckDB's cached pages back after imports and big views

While a file imports (or a big sort is written), DuckDB uses memory up to
its limit (50 % of RAM by default) and then keeps the pages cached; the
process stayed at 1–1.5 GB after a large import on Windows. Once an import
or a view write finishes, the engine lowers the memory limit for a moment
and restores it, which makes DuckDB evict its unpinned pages (166 → 61 MiB
after a 100 MB CSV here). The grid reads them back from the cache files on
demand (operating-system file cache), at no visible cost. It only happens
when nothing runs: every query, statement and import holds a shared "busy"
guard, and the release only proceeds if it can take it exclusively without
waiting. The limit itself stays configurable (`memoryLimitMb` in
`settings.json`); memory use during an import is expected.

## D34 — Layout toggles and the cell menu

The left sidebar (Ctrl+B), the SQL panel (Ctrl+J) and the column-profile
panel (Ctrl+Alt+B) have show/hide buttons at the top right of the window,
like editors have; the choice is kept. The right panel asks for a column
when none was profiled yet. Right-clicking a cell selects it (unless it is
part of the selection) and opens a menu: copy (TSV like Ctrl+C), copy with
headers, copy the cell value or the column name, copy as CSV/TSV/JSON/
Markdown/SQL INSERT, keep or exclude rows with this value, sort, profile and
reload the file (filters kept). The webview's own menu (reload, print,
inspect) is turned off everywhere except in text fields, which keep
cut/copy/paste.

## D35 — SQL results are written once, on the session, into the scratch database

A query in the SQL panel can read temp tables and variables of the panel's
session (D32), which other connections can't see, so its rows can't be
paged by re-running it elsewhere. The panel's last statement, when it is a
query (SELECT, WITH, FROM, VALUES, TABLE, DESCRIBE, SHOW, SUMMARIZE, PIVOT),
is written once on the session connection as
`CREATE TABLE dl_scratch.main.r_<n> AS SELECT * FROM (<query>)` (DuckDB
keeps the query's order) and becomes a dataset like a written-out view: the
grid pages all of its rows, a tab can own it (filters, sort, profiles, copy,
"Copy view as SQL" over the query), and it is a SQL table itself
(`result_1`). Error positions are moved back one line to the user's text.
Writing costs a little more than showing the first rows of a huge
`SELECT *`, but every result behaves the same; other statements (EXPLAIN,
PRAGMA, CREATE …) still show their rows as they come, up to 10,000. The
panel drops its previous result when a new one replaces it, unless that
result was opened in a tab.

## D36 — Exports: DuckDB `COPY` for text and Parquet, rust_xlsxwriter for Excel

CSV, CSV.gz, TSV, Parquet (zstd), JSON (one array) and NDJSON are written
by DuckDB's own `COPY (<view>) TO …` on a raw connection: it streams in
parallel, reports progress through the same progress bar as imports and
stops on `duckdb_interrupt`. The view is the same SQL the grid pages (built
from the ViewSpec with values inlined, since COPY takes no parameters),
projected to the shown columns in display order under their display names
(made unique: "total", "total (2)"). Excel files are written with
rust_xlsxwriter in constant-memory mode from DuckDB's streamed Arrow
batches (`stream_arrow`, read with `Statement::step` so an interrupt is an
error, not a panic): numbers, booleans, dates and timestamps as typed
cells (date serials with a date format), integers past 15 digits, values
outside Excel's dates and NaN/infinity as text, text cut to Excel's 32,767
characters. Past 1,048,575 data rows the user chooses more sheets (each
with the header) or the first sheet only; the outcome says how many rows
were left out. Every export goes to `<file>.partial` and is renamed when
complete, so a cancel or an error never leaves half a file or replaces a
good one. "Selected rows" are view positions (`row_number() OVER ()` over
the view query, which keeps the order the grid pages; tested against the
grid on a 300,000-row multi-threaded view, sorted and unsorted). The
suggested name is `<file>-export.<ext>`, never the open file's own name.

## D37 — "Open view in SQL panel" queries the file's table, not the file

"Copy view as SQL" must run anywhere, so it reads the file itself
(`read_csv('…')`). Inside the app the same SQL is rendered over the tab's
SQL table instead (`FROM "sales"`, D32), so editing and running it
reads the imported data, not a 5 GB file again; it is formatted and put in
the editor as one undoable change (Ctrl+Z brings the old text back). It is
not run by itself: a big view written as a result costs time the user
didn't ask for yet. Tested to give exactly the view's rows through the
panel's own path (`sql_result`).

## D38 — Charts: aggregated in DuckDB, a Grid | Chart switch per tab

A chart is computed by one query over the view's rows (filters and search;
sort and shown columns don't change a chart) and only its small result
reaches the UI: bar, horizontal bar and line group by any column (dates by
day, week, month or year) with up to four measures (count, sum, average,
min, max, distinct count); categories keep the 50 largest groups by the
first measure and say how many there are ("Top 50 of 1,234 groups");
numbers and dates on the x axis keep their order (up to 10,000 points); a
histogram reuses the column-profile binning with a chosen bar count; a
scatter plot takes a repeatable reservoir sample of 5,000 points and says
so ("5,000 of 50,000,000 points (random sample)"). On 50M cached rows each
takes 0.09–1.7 s. The plan's layout has no place for charts, so each tab's
toolbar gets a Grid | Chart switch: the chart takes the grid's place under
the same filter bar, and each tab keeps its own chart. ECharts is imported
per chart type (bar, line, scatter, custom for histograms) with the canvas
renderer, plus the SVG renderer for export. Series colours are the
data-viz reference palette's first four slots as tokens (`--series-1..4`,
own steps for dark), checked with its validator against our surfaces:
all pass except light-mode contrast of slots 3–4, so every chart also has a
table view of its values. Bars are at most 24 px thick with 4 px rounded
ends, lines 2 px, one value axis only, legend from two series up, text in
the text colours.

## D39 — Cleaning recipes: one chain of CTEs over the file, a new dataset

A recipe is an ordered list of steps, each a `SELECT` over the step before
(`WITH base AS (…), step_1 AS (…), step_2 AS (… FROM step_1) …`), so the
whole recipe is one query DuckDB plans at once and the exported script is
the same text. Column steps keep the column's place (`SELECT a, f(b) AS b,
c`); rows keep file order (duplicates keep the first row, by a row number
taken over the step's input). Change type uses `TRY_CAST` (or
`try_strptime` with a format), so a value that doesn't convert becomes
empty, and the step says how many did. Remove rows reuses the view's
filter builder with the test turned around, so the rows where the test
can't tell (NULL) stay. The output is a new dataset read through its query
and written to a session table in the background, exactly like a view, so
the cached file never changes. The tab's base becomes the cleaned rows:
the grid, filters, profiles, charts, exports and the tab's SQL table all
read them, and filters on columns a step removed or renamed are dropped.
The grid switches only when the cleaned rows' view is open, so it never
shows one set of columns over another's pages. A failing step stops the
recipe there: the rows are those of the steps before it, the step shows
DuckDB's message and the later steps say they weren't applied. Undo and
redo keep up to 100 recipes per tab. SQL results (already a query) have no
recipe.

## D40 — Recipe files: JSON with the columns they were made for

A saved recipe is a small JSON file (`"format": "dataliq-recipe"`,
`"version": 1`) holding the steps exactly as the app sends them to the
backend, the name of the file it was made on and that file's columns with
their types. Loading it onto any open file replaces that tab's recipe (one
undo brings the old one back) and compares the columns: missing columns
and columns of another type are named in the Clean panel ("This file has no
column “joined”: steps using them may fail"), and the steps still apply, so
a step that can't run says why on its own line. Files from a newer
version, other JSON and damaged recipes are refused with a sentence each.
The exported `.sql` script is the same query the app runs (D39) over the
file's reader, with a two-line header and each step's description as a
`--` comment above it; disabled steps are left out. Files are written whole
(a `.partial` file renamed), and only as `.json` or `.sql`.

## D41 — Comparing files: one full outer join, a tab of differences

Two open tabs are compared by key columns the user picks (a column named
like `id`, `key`, `code` or `…_id` is suggested). Each side's rows get
their file order and the occurrence of their key, and the join is on the
keys plus that occurrence, so a repeated key never multiplies rows: the
first `id = 5` before is matched with the first after, the second with the
second, and a third only after is added; repeated keys are counted and
mentioned. Columns both files have are compared with `IS DISTINCT FROM`
(NULL = NULL), as text when their types differ (said in the bar); columns
only one side has are listed and not compared. Comparing a cleaned tab
compares its cleaned rows. The result opens as a new tab whose rows are
only the differences, in the first file's order then the added rows:
`status`, the keys, `changed` (the changed columns' names), then each
compared column with its new value and, for columns that changed
somewhere, a `… (before)` column right after it. One aggregate query gives
the counts (added, removed, changed, the same, changes per column); the
rows are a dataset written in the background like a view, so filters,
sort, search, charts, export and "Copy view as SQL" (one query over both
files' readers) work as on any file. The bar's counts filter the rows by
status; changed cells (and their old values) are filled with a soft amber,
added rows green, removed rows red, as tokens with dark steps.

## D42 — Data quality warnings: counted with the filters that show them

Six checks, run when the Quality panel opens (and again after each
cleaning step) on the rows the tab reads: a column empty in at least 20%
of rows; text with a space at the start or end; text that is at least half
numbers but not all; text that is at least half dates written in two or
more formats; numbers further than 3 interquartile ranges outside the
middle half; and exact duplicate rows. Each warning is counted with the
very tests its "Show rows" button puts on the view (the empty, regex and
range filters), so the button always shows that many rows; duplicates,
which no column filter can show, open a query in the SQL panel listing
each duplicated row with its number of copies. Where a cleaning step fixes
a warning (trim, change type to number, remove duplicates) the panel adds
it to the recipe. Spaces are the ones `trim` removes (spaces, not tabs),
so the fix clears its warning. On 50M rows a full check took 33 s with
exact quartiles and six regexes per text column; the outlier bounds now
come from a repeatable sample of 100,000 rows (all rows when fewer), and
only text columns that are at least 40% numbers or dates in that sample are
tested for them in full, so every count is still over all rows: 6.2 s.

Unique keys (the usual case) are found with one `count(DISTINCT hash(keys))`
per side; then rows join on the keys alone, without numbering each key's
occurrences, which sorts both sides. On 50M rows against 50M (5M
differences) the numbering ran out of the container's disk while
spilling; without it the comparison takes 14 s (D41).

## D43 — Folders and patterns: an explicit file list, one table, a file column

A folder (the data files directly in it) or a pattern (`logs/*.csv.gz`,
`data/**/*.parquet`, matched with the `glob` crate) is resolved to an
explicit, name-ordered list of files, which DuckDB reads together with
`union_by_name` (a column missing from a file is empty there) and a
`filename` column holding each row's path relative to the folder (or
`source_file` when a file already has a `filename` column). Every file's
format is detected from its contents; the most common format wins, and
files of other formats and empty files are left out and counted in the
header's tooltip. Excel workbooks are not combined. The first file is
sniffed and its CSV settings apply to all; a mix of compressed and plain
files reads with DuckDB's per-file `auto` compression, and every gzip file
is checked for damage. The import, the cache (keyed on a digest of every
file's path, size and modification time, so adding, removing or editing
any file is a new version), views, SQL and "Copy as SQL" work as for one
file; a Parquet folder is queried in place. Open it with Open folder
(Shift+Ctrl+O, the empty window, the macOS File menu), a pattern from the
palette, by dropping a folder, or with `dataliq <folder>`.

Matching columns by name makes DuckDB sniff every file, which costs
seconds for a large folder (200 small `.csv.gz` files: 4.5 s before the
first rows, and the app binds the reader more than once). So when every
CSV file starts with the same header line (read cheaply in Rust, through
gzip, after any skipped lines), the files are read with the first file's
dialect and types (`files_to_sniff = 1`, no `union_by_name`): 0.28 s for
the same folder. If a later file's values then don't fit those types
(text in a number column), the import reads the folder again with every
file sniffed, so the result is the same either way; only that rare import
takes longer.

## D44 — URLs: httpfs on demand, not cached, credentials in the keychain

`https://`, `http://` and `s3://` files open like local ones (Open URL… in
the palette, or `dataliq <url>`), read by DuckDB's httpfs extension. The
app stays offline by default (the engine turns off DuckDB's extension autoloading and
autoinstalling): httpfs is installed once into the app's cache folder
(`duckdb-extensions`) and loaded only when the first URL is opened, with a
plain message when there is no internet to fetch it. The plan asked for
httpfs to be bundled; the `duckdb` crate can build in json and parquet
(and icu, autocomplete) but has no httpfs feature, so the signed extension
is downloaded from DuckDB on first use instead. That one download is the
only network access the app makes on its own behalf. The format comes from
the URL's file name (no query), since there is no file to sniff; Excel URLs
are refused. Parquet is queried in place in byte ranges, a page at a time;
CSV and JSON import into the session as usual but are never cached, because
the server's copy can change without a size or date we can trust. S3
settings (key ID, secret, region, endpoint, URL style, HTTPS) are one
keychain entry (`keyring`: macOS Keychain, Windows Credential Manager,
Secret Service on Linux); the UI is shown everything but the secret, and
saving with an empty secret keeps the stored one. They become a temporary
DuckDB secret for the session, so nothing sensitive is written to disk.
HTTP errors are said in words (404: no file at this address; 401/403:
refused, with a pointer to the S3 settings).

## D45 — Database files: attached read-only, a table at a time

SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`) and DuckDB (`.duckdb`, `.ddb`,
or a `.db` whose header says DuckDB) files are told apart by their first
bytes and attached `READ_ONLY` once per session, under a name made from the
file name (`Shop Data.duckdb` → `shop_data`, with `_2` … when two files
share a name), so the SQL panel can query any of their tables too. A
"Table" picker in the header lists tables (with row counts for DuckDB, which
knows them) and then views, `main` first and other schemas as
`schema.table`; the first table opens. DuckDB tables are queried in place
(columnar, fast); SQLite tables are imported and cached like a CSV file,
each table its own entry, because paging through SQLite from DuckDB is
slow. A file that changed on disk is detached and attached again. SQLite
needs DuckDB's sqlite extension, installed on first use like httpfs (D44);
DuckDB files need nothing. SQLite has no date type, so its dates arrive as
text (Clean changes the type). "Copy as SQL" gives `sqlite_scan(path,
table)` for SQLite, which runs in plain DuckDB with the extension; a DuckDB
table is given by its attached name (`"shop"."main"."orders"`), which
needs `ATTACH 'path' AS shop (READ_ONLY)` outside DataLiq. Databases can't
be combined in a folder or read from a URL. A file another program holds
open for writing, and one from another DuckDB version, are said in words.

## D46 — Workspaces: a `.dataliq` file of tabs, opened in place of the tabs

"Save workspace" (Ctrl/Cmd+S; "Save workspace as…" with Shift) writes the
open tabs, the SQL panel (text, open, height) and the side panels to a
`.dataliq` JSON file (`format: dataliq-workspace`, `version: 1`). For each
tab it keeps the file and only what was set on it: import settings (CSV
options, Excel sheet, database table), filters, sort and search, column
layout, SQL table name, chart and mode, recipe, and which side panel was
open. Comparison and SQL result tabs have no file behind them and are left
out (the notice says how many). The backend owns the file and its paths
and passes each tab's settings through unread, so new tab settings need no
backend change. Every file is stored by absolute path and, when inside the
workspace's folder, by its path from there: a moved or shared project
folder finds its files again. Opening a workspace (palette, file dialog,
drop, recent files, `dataliq work.dataliq`) replaces the open tabs, since a
workspace is a whole working state; each file opens as usual (from the
cache when unchanged) and its view and recipe apply when its data is ready,
the way a reload does. A missing file's tab says it is missing. Save writes
the same file again; data files are never touched.

## D47 — A menu bar on every OS, made of the palette's commands

D22 left Windows and Linux without a menu bar; people looking for Open,
Save workspace or Recent files expect one. The menus (File, Edit, View,
Data, Help) are a list of command ids (`src/lib/menus.ts`): each item runs
the same command as the palette and the keyboard, shows its title and
shortcut, and is disabled while the command isn't available (Export with
no file open), so the menus keep their shape. File has New workspace
(Ctrl+N: closes the tabs and forgets the workspace file; a viewer has no
"new file"), the open commands, Open recent (with Clear recent files),
Open / Save / Save as workspace, Export, Settings, Close tab and Exit.

On Windows and Linux the menus are drawn in the window, at the start of
the tab row (no extra row of chrome), with Radix's menubar: Alt alone or
F10 moves the focus to it, arrows and Enter work as in native menus. A
native menu there would register its shortcuts with the window and take
keys like Ctrl+F or Ctrl+E from the web view, whose handlers depend on
focus and timing (D-grid focus fixes). On macOS the menu bar is native
and built by the backend from the same list (`set_native_menu`), plus
macOS's own items: the app menu (About, Settings… ⌘,, Hide, Quit), text
editing in Edit, and Window. Native shortcuts there are only given to
app-wide actions (⌘N, ⌘O, ⇧⌘O, ⌘S, ⇧⌘S, ⌘W); the rest stay with the page
and show in the palette. A click sends the command id back as a `menu`
event. The menus are resolved in their own component, which alone
re-renders when commands change (commands register while rendering).

## D48 — Settings screen: saved to settings.json, applied at once where possible

Settings (Ctrl+, / File › Settings… / ⌘, on macOS) edits a draft and Save
applies everything; Cancel drops it. Appearance (theme, density, column
histograms) and export defaults (format, CSV delimiter, header) are UI
preferences kept by the webview, as before. Memory limit, worker threads,
the quiet-import size, the cache (on/off, size, location) and the
temporary folder are the backend's `settings.json`; the backend checks
them (memory ≥ 256 MB and ≤ the computer's, threads ≥ 1, cache ≥ 1 GB) and
says what's wrong in words, and applies memory and threads (DuckDB `SET`)
and the cache's on/off and size (a smaller size cleans up at once) without
a restart. A new cache or temporary folder applies after a restart, which
the notice says. Empty means automatic, with the automatic value shown
(half of the memory, every core, the default folders).

File associations are the installers' job: the bundle registers DataLiq
as a viewer for CSV/TSV, JSON/NDJSON, Parquet, Excel, SQLite and DuckDB
files and as the editor of `.dataliq` workspaces (`.gz` is left alone).
Making it the default app is the user's choice in the OS (Windows and
macOS don't let apps take it), so Settings says how. On macOS files opened
from the Finder arrive as an `Opened` event, which is handled like the
command line (held until the UI is ready).

## D49 — Most common values of near-unique columns: found by an estimate, counted exactly

Listing a column's most common values meant grouping by every value: on a
column where nearly every value differs (39.5M timestamps in 50M rows) that
is one group per row, 3–4 s on four cores, over the 3 s budget for column
stats. Above 1M distinct values (`APPROX_TOP_DISTINCT`, from the estimate
the statistics already compute), the candidates now come from DuckDB's
`approx_top_k` sketch and one more scan counts them exactly (about 0.8 s).
NULL, which the sketch skips, is added from the null count.

The sketch always finds values frequent enough to matter (a sentinel date in
5 % of the rows, say), which is what the list is for on such a column; it
can miss or swap values about as common as the last one listed (usually
values seen once or twice). So the counts shown are exact, and the panel
says the list was found by an estimate. Skipping the list on near-unique
columns was rejected: it would hide exactly those sentinels. Below 1M
distinct values exact counting stays: it is as fast or faster there.

## D50 — Onboarding: tips on the start screen, a sample made on demand

The first run shows three short tips on the start screen, under the drop
zone (opening big files; sorting, filtering and profiles; the palette and
SQL), one at a time with Back / Next. Closing them is remembered; Help ›
Show getting-started tips opens the same three in a dialog at any time, so
they don't depend on the start screen being visible. No tour that points at
the UI: it would need a file open and break whenever the layout changes.

"Try a sample dataset" (start screen and Help menu) opens 50,000 made-up
orders as a CSV: dates, text, decimals, booleans and a few empty customers,
so filters, charts, profiles and the quality check all have something to
show. The file is generated by DuckDB from the row number (`hash`, so the
same every time) into the app's data folder the first time it's asked for,
then reused: nothing large ships in the installers, and it opens through
the normal path (preview, quiet import) like any file the user drops.

## D51 — Updates: Tauri's updater, turned on by the release build only

DataLiq updates itself with Tauri's updater plugin: it reads a `latest.json`
manifest from the latest GitHub release, downloads the bundle for this OS
and checks its minisign signature against the public key built into the app
before installing it (Windows: the installer in passive mode; macOS: the
.app; Linux: the AppImage, .deb or .rpm it was installed from), then
restarts. `requireSignedVersion` is on: the signature must also name the
version the manifest announces, so an older, genuinely signed build can't
be served as an update (there are no older signed releases to re-sign).

The signing key belongs to whoever publishes releases, so nothing about it
is in the repository. The release workflow writes a config overlay
(`scripts/updater-config.mjs`) with the public key and manifest URL from
repository settings, and the bundler signs with the private key from a
secret. Every other build (local, CI, `check.sh`) has no updater at all:
the plugin is registered only when the config has its section (it fails to
start without a key), and Help › Check for updates says this build can't
update itself. docs/RELEASING.md says how to make and store the keys.

The app looks for an update at startup at most once a day (Settings ›
Updates, on by default; the request carries only the version), and never
installs on its own: the dialog shows the version, date and notes, and
installs on "Install and restart". Help › Check for updates asks at any
time. Our own commands wrap the plugin (rather than its JS API), so the UI
gets progress events and errors in words and the e2e mock can stand in for
it.

## D52 — Accessibility: WCAG 2.2 AA, checked by tests

The target is WCAG 2.2 AA, and each part is a test rather than a one-off
review:

- **Contrast** (`src/styles/contrast.test.ts`): every text colour token is
  at least 4.5:1 on every background it is drawn on, including the accent
  tint of selected rows, in both themes; the focus ring is at least 3:1.
  This darkened the light theme's subtle grey, null and status colours and
  lightened the dark theme's subtle grey (the old ones were 2.2–3.9:1).
- **Automated rules** (`e2e/a11y.spec.ts`, axe-core): no WCAG A/AA violation
  on the start screen, an open file, the palette, the filter editor, the
  shortcuts list, the SQL panel and Settings, in both themes.
- **Keyboard** (`e2e/keyboard.spec.ts`): a walkthrough with no mouse — the
  tips, opening files, sorting and filtering (the palette has a command per
  column), search, tabs, the SQL editor, the menu bar and Settings — with
  the focus checked at each step.

Fixes it led to: the tab bar follows the ARIA tabs pattern (one tab in the
Tab order, arrows/Home/End move, Delete closes; the close buttons are for
the mouse and no longer sit inside the tablist); targets are at least 24 px
(tab close, table rename, sidebar column rows); the SQL editor no longer
traps the keyboard (Escape then Tab leaves it, or Ctrl+M) and shows a focus
ring; the grid shows a ring while its canvas has the focus; the menu bar
and chart selects show the focus ring; the tips' Next button keeps the
focus when it becomes "Got it".

The grid itself is a canvas (Glide): it is navigated with the arrow keys and
exposes its visible cells as an accessible table to screen readers; data
beyond the visible cells is reached by scrolling, Go to row and SQL.

## D53 — The name is DataLiq, and the icon is a database with a forward chevron

The app is called **DataLiq** (data + liquid: data that flows), written with two
capitals. The name replaces the working title everywhere: the window, menus and
dialogs, installers and their file names, the bundle identifier
(`app.dataliq.desktop`, so its folders are new), the command (`dataliq file.csv`),
the workspace files (`.dataliq`, format `dataliq-workspace`), recipe files, the
crate (`dataliq` / `dataliq_lib`), internal SQL names (`dl_` prefix), local
storage keys and the release variables (`DATALIQ_UPDATER_PUBKEY`). No build has
been published, so nothing reads the old names.

The icon (`assets/icon.svg`, rendered into every size by `tauri icon`) follows
the current desktop style: bold, flat shapes on a dark graphite tile sized to
Apple's icon grid. A database stack of three discs in a cyan-to-violet
gradient says data; an amber chevron pointing forward beside it says fast.
It stays legible at 32 px and on light and dark backgrounds, and also appears
in Help › About. It was chosen from three concepts (a "D" with a lightning
bolt, a table struck by a bolt, this one), after two earlier drafts (a drop
made of data rows, an arrow made of bars) were set aside at review.

## D54 — The grid, SQL editor and charts load on first use

By 1.0 the UI was one 2.2 MB JavaScript bundle (Glide, CodeMirror, ECharts,
Arrow), and parsing it at startup pushed "UI ready" to 1.05–1.43 s against
the 1 s budget. `FileView` (grid), `SqlPanel` (CodeMirror) and `ChartPanel`
(ECharts) are now `React.lazy` chunks behind `Suspense` with no fallback (the
area stays empty for the few milliseconds the chunk takes from disk). The
start screen loads a 681 kB bundle and is ready in 0.89–0.93 s. No
prefetching: the chunks come from the app's own files, not the network.

Anything that reaches into a lazily mounted component must wait for it:
the SQL store's `focusEditor` (Ctrl+J) and `load` call the editor once it
has registered itself, not on the next tick.

