# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/mukesh-dsnl/dataliq/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mukesh-dsnl/dataliq/releases/tag/v0.1.0
