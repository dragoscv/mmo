# dev-on-win.ps1 — Windows entrypoint that proxies dev-on-win.sh through WSL.
#
# Run from VS Code task "Companion: Dev on Windows VM" or directly:
#   pwsh server/scripts/dev-on-win.ps1            # one-shot deploy
#   pwsh server/scripts/dev-on-win.ps1 -Watch     # deploy + watch + auto-reload
#
# Requires:
#   - WSL distro Ubuntu-24.04 with sshpass installed
#   - Windows VM reachable on host's 2222 (netsh portproxy -> VM:22)
#     (set up with: netsh interface portproxy add v4tov4 listenport=2222
#      listenaddress=0.0.0.0 connectport=22 connectaddress=<vm-ip>)
[CmdletBinding()]
param(
    [switch]$Watch
)
$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
# Convert to forward-slashes so wsl.exe / bash don't strip backslash escapes.
$repoFwd  = $repoRoot.Path -replace '\\','/'
$wslPath  = (wsl -d Ubuntu-24.04 -- wslpath -a "$repoFwd").Trim()
Write-Host "[dev] WSL repo path: $wslPath"
$flag = if ($Watch) { "--watch" } else { "" }
wsl -d Ubuntu-24.04 -- bash -lc "cd '$wslPath/server' && bash scripts/dev-on-win.sh $flag"
