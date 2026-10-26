# Architecture

BigView never loads a whole file into memory and never sends more rows to the
UI than are visible. DuckDB reads from disk; the UI only receives small Apache
Arrow pages and small aggregates.

## Layout

```
src-tauri/            Rust backend (Tauri v2)
  src/lib.rs          app setup
  src/commands/       thin Tauri command handlers
  src/engine/         DuckDB session, cancellation
  src/sources/        format detection + readers
  src/import/         preview, background import, progress
  src/cache/          dataset cache
  src/view/           ViewSpec -> SQL
  tests/              integration tests
  benches/            criterion benchmarks
src/                  React frontend
  app/                app shell
  components/         grid, filters, sql, charts, sidebar, palette
  stores/             Zustand stores
  lib/                IPC + Arrow helpers
  styles/             design tokens and global CSS
scripts/              check, smoke and fixture generation scripts
fixtures/             small committed fixtures (< 1 MB each)
docs/                 decisions, benchmarks, architecture
```

Modules are added as the roadmap reaches them.

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

## Data flow

```
UI (grid, filters, SQL)  --ViewSpec / SQL-->  Tauri command
   ^                                              |
   | Arrow IPC bytes (one page or one aggregate)  v
   +------------------------------------  Rust: view builder -> DuckDB
```
