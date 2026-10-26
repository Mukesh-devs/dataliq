# Design decisions

Deviations from, or clarifications of, `BUILD_PLAN.md`, with the reasoning.

## D1 — Repository root is the project root

The plan shows a `bigview/` folder. This repository *is* the project, so
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
