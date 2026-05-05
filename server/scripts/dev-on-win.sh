#!/usr/bin/env bash
# dev-on-win.sh — run the Companion in dev mode on the Windows VM with live source.
#
# Runs from inside WSL (Ubuntu-24.04). The Windows VM is reached via the
# host's netsh portproxy (host:2222 -> VM:22). Default remote shell on the
# VM is Windows PowerShell 5.1, so all remote commands are PS heredocs.
#
# IMPORTANT: We DO NOT run npm install on the VM. The VM does not have
# Python or VS Build Tools, so node-gyp can't compile better-sqlite3 /
# audify. Instead, we build node_modules on the host (which IS Windows
# x64 — same arch/abi as the VM) and ship the entire tree over SSH. The
# host must have run `pnpm install` (and ideally `pnpm exec electron-rebuild`)
# in server/ at least once.
#
# Usage:
#   bash dev-on-win.sh             # one-shot deploy + launch
#   bash dev-on-win.sh --watch     # deploy, then watch local files and
#                                  # sync incrementally on every change
#                                  # (tsc --watch + electronmon on the VM)
#
# Env vars (override defaults):
#   WIN_HOST        172.23.192.1   # WSL gateway (where netsh portproxy listens)
#   WIN_PORT        2222
#   WIN_USER        dragos
#   WIN_PASS        papuci123
#   WIN_DIR         C:/Users/dragos/companion-dev
#   INSPECT_PORT    9229
#   DEVTOOLS_PORT   9222

set -euo pipefail

WATCH_MODE=0
if [ "${1:-}" = "--watch" ]; then WATCH_MODE=1; fi

WIN_HOST=${WIN_HOST:-172.23.192.1}
WIN_PORT=${WIN_PORT:-2222}
WIN_USER=${WIN_USER:-dragos}
WIN_PASS=${WIN_PASS:-papuci123}
WIN_DIR=${WIN_DIR:-C:/Users/dragos/companion-dev}
INSPECT_PORT=${INSPECT_PORT:-9229}
DEVTOOLS_PORT=${DEVTOOLS_PORT:-9222}

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "[dev] source: $SRC_ROOT"
echo "[dev] target: $WIN_USER@$WIN_HOST:$WIN_PORT  ->  $WIN_DIR"
echo "[dev] watch:  $WATCH_MODE"

if [ ! -d "$SRC_ROOT/node_modules" ]; then
    echo "[dev] FATAL: $SRC_ROOT/node_modules missing." >&2
    echo "       Run 'pnpm install' (or 'npm install') in server/ on the host first." >&2
    exit 1
fi
if [ ! -f "$SRC_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
    echo "[dev] WARNING: better-sqlite3 native binary missing on host." >&2
    echo "       Run 'pnpm exec electron-rebuild' in server/ on the host." >&2
fi

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$WIN_PORT")
SCP_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -P "$WIN_PORT")

# Run a PowerShell command on the VM. We feed it as a single -EncodedCommand
# to avoid quoting nightmares with PS 5.1's command-line parser.
run_ps() {
    local script="$1"
    local encoded
    encoded=$(printf '%s' "$script" | iconv -t UTF-16LE | base64 -w0)
    sshpass -p "$WIN_PASS" ssh "${SSH_OPTS[@]}" "$WIN_USER@$WIN_HOST" \
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
}

# Tar the listed top-level paths locally, scp the tarball to the VM, then
# extract with the VM's built-in tar.exe.
sync_paths() {
    local label="$1"; shift
    echo "[dev] sync $label: $*"
    local tmp
    tmp=$(mktemp /tmp/companion-sync-XXXXXX.tgz)
    ( cd "$SRC_ROOT" && tar -czf "$tmp" \
        --anchored \
        --exclude='dist' --exclude='release' --exclude='*.log' \
        "$@" )
    local size
    size=$(du -h "$tmp" | cut -f1)
    echo "[dev] tarball: $size"
    sshpass -p "$WIN_PASS" scp "${SCP_OPTS[@]}" "$tmp" \
        "$WIN_USER@$WIN_HOST:companion-dev-sync.tgz" >/dev/null
    rm -f "$tmp"
    run_ps "
\$ErrorActionPreference = 'Stop'
\$dst = '$WIN_DIR'
New-Item -Force -ItemType Directory \$dst | Out-Null
Push-Location \$dst
& tar.exe -xzf \$env:USERPROFILE\\companion-dev-sync.tgz
Pop-Location
Remove-Item \$env:USERPROFILE\\companion-dev-sync.tgz -Force -ErrorAction SilentlyContinue
"
}

echo "[dev] ensuring target dir exists"
run_ps "New-Item -Force -ItemType Directory '$WIN_DIR' | Out-Null"

echo "[dev] killing previous dev electron + tsc-watch + electronmon"
run_ps "
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { \$_.Path -and \$_.Path -like '*companion-dev*' -and (\$_.ProcessName -match 'electron|node|tsc') } |
  ForEach-Object { Stop-Process -Id \$_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
"

# Determine if node_modules needs to be re-shipped.
HOST_PKG_MTIME=$(stat -c %Y "$SRC_ROOT/package.json")
REMOTE_MARKER=$(run_ps "
\$m = '$WIN_DIR/node_modules/.synced-mtime'
if (Test-Path \$m) { Get-Content \$m -Raw } else { Write-Output '0' }
" | tr -d '\r\n ')
NEEDS_FULL_SYNC=0
if [ -z "$REMOTE_MARKER" ] || [ "$REMOTE_MARKER" = "0" ] || [ "$HOST_PKG_MTIME" -gt "$REMOTE_MARKER" ]; then
    NEEDS_FULL_SYNC=1
fi

if [ "$NEEDS_FULL_SYNC" = "1" ]; then
    echo "[dev] node_modules missing/stale on VM — shipping full tree (this is slow the first time)"
    sync_paths "node_modules" node_modules
    run_ps "Set-Content -Path '$WIN_DIR/node_modules/.synced-mtime' -Value '$HOST_PKG_MTIME' -NoNewline"
else
    echo "[dev] node_modules in sync (host pkg mtime=$HOST_PKG_MTIME, remote=$REMOTE_MARKER)"
fi

echo "[dev] sync source"
sync_paths "source" package.json tsconfig.json src ui assets python scripts

echo "[dev] running tsc on VM"
run_ps "
\$ErrorActionPreference = 'Stop'
Set-Location '$WIN_DIR'
& node 'node_modules\\typescript\\bin\\tsc'
if (\$LASTEXITCODE -ne 0) { throw 'tsc failed' }
Write-Host '[dev] tsc OK'
"

echo "[dev] freeing port 17899 (any installed Companion holding it)"
run_ps "
Get-NetTCPConnection -LocalPort 17899 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
"

if [ "$WATCH_MODE" = "1" ]; then
    echo "[dev] starting tsc --watch on the VM"
    run_ps "
Set-Location '$WIN_DIR'
\$cmd = 'cmd.exe /c start \"\" /B node node_modules\\typescript\\bin\\tsc --watch --preserveWatchOutput ' +
       '> \"' + \$env:TEMP + '\\companion-tsc.log\" 2> \"' + \$env:TEMP + '\\companion-tsc.err\"'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = \$cmd; CurrentDirectory = '$WIN_DIR'
} | Out-Null
Start-Sleep -Seconds 4
Write-Host '---TSC LOG---'
Get-Content \$env:TEMP\\companion-tsc.log -Tail 5 -ErrorAction SilentlyContinue
"

    echo "[dev] starting electronmon on the VM (auto-restart on dist/ + ui/ changes)"
    run_ps "
Set-Location '$WIN_DIR'
Remove-Item \$env:TEMP\\companion-dev.log,\$env:TEMP\\companion-dev.err -Force -ErrorAction SilentlyContinue
\$cmd = 'cmd.exe /c start \"\" /B node node_modules\\electronmon\\bin\\cli.js . ' +
       '> \"' + \$env:TEMP + '\\companion-dev.log\" 2> \"' + \$env:TEMP + '\\companion-dev.err\"'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = \$cmd; CurrentDirectory = '$WIN_DIR'
} | Out-Null
Start-Sleep -Seconds 10
Write-Host '---DEV LOG---'
Get-Content \$env:TEMP\\companion-dev.log -Tail 40 -ErrorAction SilentlyContinue
Write-Host '---PORTS---'
Get-NetTCPConnection -State Listen -LocalPort 17899 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize
"

    echo "[dev] starting host-side file watcher (chokidar) — Ctrl+C to stop"
    cd "$SRC_ROOT"
    MAC_HOST="$WIN_HOST" MAC_PORT="$WIN_PORT" MAC_USER="$WIN_USER" \
        MAC_PASS="$WIN_PASS" MAC_DIR="$WIN_DIR" \
        exec node "$SRC_ROOT/scripts/watch-mac-sync.mjs" \
            --target "$WIN_USER@$WIN_HOST:$WIN_PORT:$WIN_DIR" \
            --pass "$WIN_PASS"
else
    echo "[dev] launching electron (one-shot)"
    echo "[dev] DevTools (renderer): http://${WIN_HOST}:${DEVTOOLS_PORT}"
    echo "[dev] Inspector (main):    chrome://inspect → ${WIN_HOST}:${INSPECT_PORT}"
    run_ps "
Set-Location '$WIN_DIR'
Remove-Item \$env:TEMP\\companion-dev.log,\$env:TEMP\\companion-dev.err -Force -ErrorAction SilentlyContinue
\$electron = Join-Path '$WIN_DIR' 'node_modules\\electron\\dist\\electron.exe'
if (-not (Test-Path \$electron)) { throw \"electron.exe missing at \$electron — run 'pnpm install' in server/ on the host\" }
# Use WMI to truly detach the process from the SSH session, otherwise it
# gets killed when SSH disconnects. cmd /c start /B redirects stdio to log
# files and the empty title is required by 'start' when the program path
# is quoted.
\$cmd = 'cmd.exe /c start \"\" /B \"' + \$electron + '\" ' +
       '--inspect=0.0.0.0:$INSPECT_PORT ' +
       '--remote-debugging-port=$DEVTOOLS_PORT ' +
       '--remote-allow-origins=* ' +
       'dist\\main.js ' +
       '> \"' + \$env:TEMP + '\\companion-dev.log\" ' +
       '2> \"' + \$env:TEMP + '\\companion-dev.err\"'
\$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = \$cmd;
  CurrentDirectory = '$WIN_DIR'
}
Write-Host (\"[dev] launched cmd shim — wmi returnvalue=\" + \$result.ReturnValue + \" pid=\" + \$result.ProcessId)
Start-Sleep -Seconds 12
Write-Host '---DEV LOG---'
Get-Content \$env:TEMP\\companion-dev.log -Tail 60 -ErrorAction SilentlyContinue
Write-Host '---DEV ERR---'
Get-Content \$env:TEMP\\companion-dev.err -Tail 20 -ErrorAction SilentlyContinue
Write-Host '---PORTS---'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { \$_.LocalPort -in 17899,$INSPECT_PORT,$DEVTOOLS_PORT } |
  Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize
Write-Host '---ELECTRON PROCESS---'
Get-Process electron -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | Format-Table -AutoSize
"
fi
