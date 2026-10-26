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
- Check scripts (`scripts/check.sh`, `scripts/check.ps1`) and CI on Windows, macOS and Linux.
