# Full check script for Windows (PowerShell). Mirrors scripts/check.sh.
#   ./scripts/check.ps1           run everything (including `tauri build --debug`)
#   ./scripts/check.ps1 -Quick    skip the Tauri bundle build
param([switch]$Quick)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Step([string]$Name, [scriptblock]$Cmd) {
  Write-Host "`n==> $Name" -ForegroundColor Blue
  & $Cmd
  if ($LASTEXITCODE -ne 0) { throw "Step failed: $Name" }
}

Step "cargo fmt --check" { cargo fmt --all --check }
Step "cargo clippy" { cargo clippy --all-targets -- -D warnings }
Step "cargo test" { cargo test }
Step "pnpm lint" { pnpm lint }
Step "pnpm typecheck" { pnpm typecheck }
Step "pnpm test" { pnpm test }
Step "pnpm e2e (Playwright)" { pnpm e2e }
if (-not $Quick) {
  Step "pnpm tauri build --debug" { pnpm tauri build --debug }
}
Write-Host "`nAll checks passed." -ForegroundColor Green
