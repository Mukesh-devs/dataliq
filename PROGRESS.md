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
