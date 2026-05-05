# dev-on-linux.ps1 — Windows entrypoint that proxies dev-on-linux.sh through WSL.
#
# Run from VS Code task "Companion: Dev on Linux VM" or directly:
#   pwsh server/scripts/dev-on-linux.ps1            # one-shot deploy
#   pwsh server/scripts/dev-on-linux.ps1 -Watch     # deploy + watch + auto-reload
#
# Requires:
#   - WSL distro Ubuntu-24.04 with sshpass installed
#   - Ubuntu VM reachable on 127.0.0.1:10024 from inside that distro
[CmdletBinding()]
param(
    [switch]$Watch
)
$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$wslPath  = (wsl -d Ubuntu-24.04 -- wslpath -a "$($repoRoot.Path)").Trim()
Write-Host "[dev] WSL repo path: $wslPath"
$flag = if ($Watch) { "--watch" } else { "" }
wsl -d Ubuntu-24.04 -- bash -lc "cd '$wslPath/server' && bash scripts/dev-on-linux.sh $flag"
