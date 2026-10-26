# BigView

> Drag in a 5 GB file. See data in 1 second. Filter, query, and export without loading it into RAM.

BigView is a free, open-source, cross-platform desktop app for exploring huge
tabular files: CSV, TSV, Parquet, JSON/NDJSON and Excel, including `.gz`
compressed files of 5 GB and more. It is built with [Tauri v2](https://tauri.app),
Rust and [DuckDB](https://duckdb.org). It works fully offline, with no telemetry
and no account.

**Status:** early development (v0.1 in progress). See [PROGRESS.md](PROGRESS.md)
and the roadmap in [BUILD_PLAN.md](BUILD_PLAN.md).

## Features

- Open CSV and TSV files, also compressed (`.gz`, `.zst`), with the first
  1,000 rows on screen in about a second, even for 5 GB `.csv.gz` files.
- Delimiter, header, quoting and types are detected automatically; override
  them in **Import settings** (delimiter, header, quote, encoding, skip rows,
  date format, ignore bad rows).
- A fast canvas data grid: type icons, right-aligned numbers, `null` shown
  distinctly from empty text, column resize, range selection and copy, and
  **Go to row** (Ctrl+G).
- Light and dark themes that follow your OS.

_Coming in v0.1:_ JSON/NDJSON, Parquet and Excel, background import with a disk cache, tabs and opening from the terminal.

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
```

## License

[MIT](LICENSE)
