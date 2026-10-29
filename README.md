<div align="center">

<img src="assets/icon.svg" width="120" alt="DataLiq icon: a database stack with a forward chevron">

# DataLiq

**Open huge data files in seconds. Filter, query and export without loading them into RAM.**

Drag in a 5 GB **CSV**, **Parquet**, **JSON** or **Excel** file and see your data in about a
second. Browse, filter, chart, clean and export millions of rows on **Windows**, **macOS** and
**Linux**. No account. No telemetry. Fully offline.

[![Latest release](https://img.shields.io/github/v/release/Mukesh-devs/dataliq?label=release&color=2563eb)](https://github.com/Mukesh-devs/dataliq/releases/latest)
![Windows 10+](https://img.shields.io/badge/Windows-10%2B-0078D4?logo=windows&logoColor=white)
![macOS 12+](https://img.shields.io/badge/macOS-12%2B-000000?logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-x64-FCC624?logo=linux&logoColor=black)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

[**⬇ Download**](https://github.com/Mukesh-devs/dataliq/releases/latest) ·
[**Features**](#features) ·
[**Installation**](#installation) ·
[**Changelog**](CHANGELOG.md)

</div>

<br>

![A CSV file open in the grid, with the profile of its unit_price column](docs/screenshots/grid-light.png)

| SQL over every open file | Charts of millions of rows |
| --- | --- |
| ![The SQL panel: a grouped query over the open file and its 20 result rows](docs/screenshots/sql-light.png) | ![A bar chart of the sum of unit_price by category, in the dark theme](docs/screenshots/chart-dark.png) |

<p align="center"><sub>The screenshots show the built-in sample dataset (Help › Open the sample dataset).</sub></p>

## Features

###  Open anything

- CSV, TSV, JSON, NDJSON, Parquet and Excel files, also compressed (`.gz`, `.zst`).
- SQLite and DuckDB databases (read-only).
- A whole folder or a pattern such as `logs/*.csv.gz` as one table.
- Files on the web or in S3 with **Open URL**.
- Delimiters, headers and column types are detected for you, and you can change them.

###  Explore

- A fast grid that scrolls smoothly through millions of rows.
- Filter, sort and search any column.
- Hide, reorder, pin and rename columns.
- Column profiles: nulls, distinct values, min, max, mean and a histogram.

###  Analyze

- **SQL panel**: query and join every open file as a table.
- **Charts**: bar, line, histogram and scatter, export as PNG or SVG.
- **Compare** two files and see the added, removed and changed rows.
- **Data quality** warnings for empty columns, mixed types, outliers and duplicates.

###  Clean and export

- **Clean** without touching the original file: rename, change types, trim, find and
  replace, fill empty cells, remove duplicates. Undo any step.
- Save your steps as a recipe and reuse it on the next file.
- **Export** to CSV, TSV, Parquet, JSON or Excel.
- Copy a selection as CSV, JSON, Markdown or SQL.

###  Everyday comforts

- **Workspaces** save your open files, filters and charts to reopen later.
- A command palette (Ctrl+K) with every action.
- Light and dark themes, keyboard access to everything, and a sample dataset to try.
- Updates from signed releases, installed only when you say so.

###  Private by design

Nothing leaves your computer. The only network requests are the URLs you open and, if you
keep it on, a daily check for a new version.

## Installation

Download the file for your system from the
[latest release](https://github.com/Mukesh-devs/dataliq/releases/latest). Each release lists
SHA-256 checksums of its files.

| System | Download |
| --- | --- |
| Windows 10/11 (x64) | `DataLiq_<version>_x64-setup.exe` |
| macOS 12+, Apple silicon (M1–M4) | `DataLiq_<version>_aarch64.dmg` |
| macOS 12+, Intel | `DataLiq_<version>_x64.dmg` |
| Linux (x64), any distribution | `DataLiq_<version>_amd64.AppImage` |
| Debian / Ubuntu | `DataLiq_<version>_amd64.deb` |
| Fedora / openSUSE | `DataLiq-<version>-1.x86_64.rpm` |

### Windows

1. Download `DataLiq_<version>_x64-setup.exe`.
2. Run it. It installs for your user only, so no admin rights are needed.
3. If SmartScreen warns about an unrecognised app, click **More info › Run anyway**.

> For managed machines, use `DataLiq_<version>_x64_en-US.msi` instead. WebView2 comes with
> Windows 11 and is installed by the setup if it is missing.

### macOS

1. Check your Mac: **Apple menu › About This Mac**. Pick `aarch64` for Apple silicon (M1–M4)
   or `x64` for Intel.
2. Open the `.dmg` and drag **DataLiq** to **Applications**.
3. If the release isn't notarized, the first time right-click **DataLiq › Open**.

### Linux

**AppImage** (any distribution):

```sh
chmod +x DataLiq_<version>_amd64.AppImage
./DataLiq_<version>_amd64.AppImage
```

**Debian / Ubuntu**:

```sh
sudo apt install ./DataLiq_<version>_amd64.deb
```

**Fedora / openSUSE**:

```sh
sudo dnf install ./DataLiq-<version>-1.x86_64.rpm
```

> Linux needs WebKitGTK 4.1, which is preinstalled on most desktops.

### After installing

The installers register DataLiq for CSV, TSV, JSON, NDJSON, Parquet, Excel, SQLite and DuckDB
files and `.dataliq` workspaces (Settings says how to make it the default app). From a
terminal, `dataliq data.csv.gz other.parquet` opens files in a running DataLiq.

## Keyboard shortcuts

Use Cmd on macOS, Ctrl elsewhere.

| Action | Shortcut |
| --- | --- |
| Menu bar (Windows, Linux) | Alt or F10 |
| New workspace | Ctrl+N |
| Open file | Ctrl+O |
| Open folder as one table | Shift+Ctrl+O |
| Save workspace / Save as | Ctrl+S / Shift+Ctrl+S |
| Command palette | Ctrl+K |
| Find in data | Ctrl+F |
| Close tab | Ctrl+W (or Delete on a focused tab) |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab (arrows in the tab bar) |
| Go to row | Ctrl+G |
| Copy selection (TSV) | Ctrl+C |
| Copy as CSV / JSON / Markdown / SQL | Shift+Ctrl+C |
| Sort by a column / add a sort key | Click / Shift+click a header |
| Export | Ctrl+E |
| Show / hide the SQL panel | Ctrl+J |
| Run SQL (or the selection) | Ctrl+Enter |
| Leave the SQL editor (Tab indents there) | Escape, then Tab |
| Show / hide the sidebar | Ctrl+B |
| Show / hide the column profile | Ctrl+Alt+B |
| Settings | Ctrl+, |

## Performance

Measured with the dev profile on GitHub-hosted runners (4 vCPU) and a 4-core Linux machine;
every number per OS is in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

| | Linux | Windows | macOS |
| --- | --- | --- | --- |
| First rows of a 5 GB CSV | 0.28 s | 0.34 s | 0.30 s |
| First rows of a 5 GB `.csv.gz` | 1.2 s | 1.4 s | 0.9 s |
| Full import of a 5 GB CSV (46M rows) | 40 s | 48 s | 19 s |
| Reopen a cached file | 2 ms | 3 ms | 2 ms |
| Open a 50M-row Parquet file | 0.05 s | 0.07 s | 0.04 s |
| Filter 50M rows: first rows | 0.1–0.9 s | 0.1–1.1 s | 0.02–0.2 s |
| Sort 50M rows: first and last rows | 0.8–1.0 s | 0.9–1.2 s | 0.3 s |
| Column profile of 50M rows | 0.7–2.7 s | 0.6–2.6 s | 0.2–2.9 s |
| Chart of 50M rows | 0.1–1.9 s | 0.1–2.3 s | 0.04–1.5 s |

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

The design is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Bug reports, ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © DataLiq contributors
