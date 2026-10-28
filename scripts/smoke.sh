#!/usr/bin/env bash
# Launches the built debug app in a virtual X display, waits, and saves a
# screenshot of the whole screen. Linux only; used for manual smoke checks.
# Usage: scripts/smoke.sh <output.png> [seconds] [-- app args...]
set -euo pipefail
out="${1:?output png path}"; shift
wait_s="${1:-6}"; [[ $# -gt 0 ]] && shift
[[ "${1:-}" == "--" ]] && shift
bin="$(cd "$(dirname "$0")/.." && pwd)/target/debug/dataliq"
xvfb-run -a -s "-screen 0 1280x800x24" bash -c '
  "$0" "${@:3}" > "$2.log" 2>&1 & pid=$!
  sleep "$1"
  import -window root "$2"
  kill $pid 2>/dev/null || true
' "$bin" "$wait_s" "$out" "$@"
echo "screenshot: $out"
