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

## Data flow

```
UI (grid, filters, SQL)  --ViewSpec / SQL-->  Tauri command
   ^                                              |
   | Arrow IPC bytes (one page or one aggregate)  v
   +------------------------------------  Rust: view builder -> DuckDB
```
