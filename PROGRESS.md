# Progress

Tracks each step of [BUILD_PLAN.md](BUILD_PLAN.md): what was done, how it was
tested, and anything left over.

## v0.1 — Core viewer

### Step 1 — Scaffold ✅

- Tauri v2 (2.12) + React 18 + TypeScript 6 (strict) + Vite 8 + Tailwind CSS 4.
- Cargo workspace at the repo root with the app crate in `src-tauri/`.
- `scripts/check.sh` / `scripts/check.ps1`, `scripts/smoke.sh` (Linux screenshot smoke check).
- CI (`.github/workflows/ci.yml`): checks + `tauri build --debug` on Ubuntu, macOS, Windows.
- Docs: README, CHANGELOG, CONTRIBUTING, LICENSE (MIT), docs/ARCHITECTURE, DECISIONS, BENCHMARKS.
- Tested: Vitest render test; `scripts/check.sh` passes locally (Linux); smoke check —
  the debug binary opens a 1280×800 window showing "BigView" (Xvfb screenshot).
- Left over: none.

### Step 2 — Design system and app shell ✅

- Design tokens as CSS variables (`src/styles/tokens.css`) mapped to Tailwind utilities;
  light and dark themes, following the OS by default; compact/comfortable density.
- Inter + JetBrains Mono bundled from `@fontsource-variable` (no CDN).
- Layout: tab bar (+ open button, search / Ctrl+K box), sidebar (Files, Columns),
  main area, status bar with theme toggle. Empty state: drop zone + recent files.
- Tested: Vitest render tests (layout regions, empty state, theme switching, density,
  shortcut formatting, settings store); Playwright screenshots of both themes plus a
  theme-persistence flow. Smoke check: the debug app window shows the shell with the
  bundled fonts under the strict CSP.
- Left over: drag-and-drop and Open are wired up in step 10 (Tabs and opening).

### Step 3 — DuckDB engine ✅

- `engine::Engine`: in-memory DuckDB (bundled, with json + parquet compiled in, extension
  auto-install/auto-load off), memory limit (default 50% RAM) and spill dir from
  `settings.json` (OS config dir, written with defaults on first start), one connection per
  query, request registry with cancel-by-id and "newer request in a group wins".
- Commands `run_query` (returns raw Arrow IPC via `tauri::ipc::Response`, capped at 100k rows)
  and `cancel_query`; per-command permissions in `capabilities/default.json`.
- Frontend: `src/lib/arrow.ts` (decode + type mapping), `src/lib/ipc.ts` (typed `invoke`,
  `BigViewError`), status bar shows the DuckDB version via a real Arrow round trip.
- Logging with `tracing` to stderr and a daily-rolling file in the app log dir.
- Tested: 10 engine integration tests (types/values of a known query, IPC round trip vs a
  committed fixture, empty results keep schema, bound parameters, row cap, memory/temp/thread
  settings, offline JSON+Parquet, plain error messages, cancel by id, group cancel) + unit
  tests for settings/errors/params; Vitest decodes the Rust-written IPC fixture and tests the
  engine store with mocked IPC. Benchmark: 0.58 ms per 1,000-row page (docs/BENCHMARKS.md).
  Smoke check: app status bar shows "Ready · DuckDB v1.5.6"; settings.json and log file created.
- Left over: none.
