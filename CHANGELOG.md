# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Check scripts (`scripts/check.sh`, `scripts/check.ps1`) and CI on Windows, macOS and Linux.
