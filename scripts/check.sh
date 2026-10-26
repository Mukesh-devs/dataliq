#!/usr/bin/env bash
# Full check script. Every step must pass before a commit.
#   scripts/check.sh           run everything (including `tauri build --debug`)
#   scripts/check.sh --quick   skip the Tauri bundle build (for fast local loops)
set -euo pipefail
cd "$(dirname "$0")/.."

quick=0
[[ "${1:-}" == "--quick" ]] && quick=1

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "cargo fmt --check"
cargo fmt --all --check

step "cargo clippy"
cargo clippy --all-targets -- -D warnings

step "cargo test"
cargo test

step "pnpm lint"
pnpm lint

step "pnpm typecheck"
pnpm typecheck

step "pnpm test"
pnpm test

if [[ $quick -eq 0 ]]; then
  step "pnpm tauri build --debug"
  pnpm tauri build --debug
fi

printf '\n\033[1;32mAll checks passed.\033[0m\n'
